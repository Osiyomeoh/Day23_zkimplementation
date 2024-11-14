// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract ProductionZkRollup {
    // State variables
    address public owner;
    bool private locked;
    bool public paused;
    
    uint256 public constant BATCH_SIZE = 32;
    uint256 public constant MAX_AMOUNT = 2**128 - 1;
    uint256 public constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    
    // Account structure
    struct Account {
        uint256 balance;
        uint256 nonce;
        bytes32 pubKeyHash;
    }
    
    // Transaction structure
    struct Transaction {
        uint256 fromIndex;
        uint256 toIndex;
        uint256 amount;
        uint256 fee;
        uint256 nonce;
        bytes signature;
    }
    
    // Batch structure
    struct Batch {
        bytes32 stateRoot;      // Merkle root of the state
        bytes32 txRoot;         // Merkle root of transactions
        uint256 timestamp;
        bool verified;
        uint256 totalFees;
    }

    // Storage
    mapping(uint256 => Account) public accounts;
    mapping(uint256 => Batch) public batches;
    mapping(address => uint256) public accountIndices;
    
    uint256 public totalAccounts;
    uint256 public currentBatch;
    bytes32 public currentStateRoot;

    // Events
    event AccountCreated(uint256 indexed index, address indexed owner, bytes32 pubKeyHash);
    event Deposit(uint256 indexed accountIndex, uint256 amount);
    event BatchSubmitted(uint256 indexed batchId, bytes32 stateRoot, bytes32 txRoot);
    event BatchVerified(uint256 indexed batchId);
    event Withdrawal(uint256 indexed accountIndex, address recipient, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address account);
    event Unpaused(address account);

    // Errors
    error NotOwner();
    error ReentrantCall();
    error ContractPaused();
    error InvalidProof();
    error InvalidSignature();
    error InvalidAccount();
    error InsufficientBalance();
    error InvalidAmount();
    error BatchNotFound();
    error BatchAlreadyVerified();
    error NonceAlreadyUsed();

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner();
        }
        _;
    }

    modifier nonReentrant() {
        if (locked) {
            revert ReentrantCall();
        }
        locked = true;
        _;
        locked = false;
    }

    modifier whenNotPaused() {
        if (paused) {
            revert ContractPaused();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        currentStateRoot = bytes32(0);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner is the zero address");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }
    
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function createAccount(bytes32 _pubKeyHash) external returns (uint256) {
        require(accountIndices[msg.sender] == 0, "Account already exists");
        
        totalAccounts++;
        uint256 index = totalAccounts;
        
        accounts[index] = Account({
            balance: 0,
            nonce: 0,
            pubKeyHash: _pubKeyHash
        });
        
        accountIndices[msg.sender] = index;
        
        emit AccountCreated(index, msg.sender, _pubKeyHash);
        return index;
    }

    function deposit(uint256 _accountIndex) external payable nonReentrant whenNotPaused {
        if (_accountIndex == 0 || _accountIndex > totalAccounts) revert InvalidAccount();
        if (msg.value == 0 || msg.value > MAX_AMOUNT) revert InvalidAmount();
        
        Account storage account = accounts[_accountIndex];
        account.balance += msg.value;
        
        currentStateRoot = updateMerkleRoot(currentStateRoot, _accountIndex, account);
        
        emit Deposit(_accountIndex, msg.value);
    }

    function submitBatch(
        Transaction[] calldata _txs,
        bytes32 _newStateRoot
    ) external onlyOwner whenNotPaused {
        require(_txs.length <= BATCH_SIZE, "Batch too large");
        
        bytes32 txRoot = computeTxRoot(_txs);
        
        uint256 batchId = currentBatch++;
        batches[batchId] = Batch({
            stateRoot: _newStateRoot,
            txRoot: txRoot,
            timestamp: block.timestamp,
            verified: true,
            totalFees: calculateTotalFees(_txs)
        });
        
        currentStateRoot = _newStateRoot;
        
        emit BatchSubmitted(batchId, _newStateRoot, txRoot);
        emit BatchVerified(batchId);
    }

    function withdraw(
    uint256 _accountIndex,
    uint256 _amount,
    bytes32[] calldata _merkleProof
) external nonReentrant whenNotPaused {
    Account storage account = accounts[_accountIndex];
    
    // Check account ownership first
    if (msg.sender != accountOwner(_accountIndex)) {
        revert("Not account owner");
    }
    
    // Check balance before verification to save gas
    if (account.balance < _amount) {
        revert InsufficientBalance();
    }
    
    // Verify Merkle proof
    if (!verifyMerkleProof(_merkleProof, currentStateRoot, _accountIndex, account)) {
        revert("Invalid Merkle proof");
    }
    
    // Update state
    account.balance -= _amount;
    account.nonce++;
    
    // Update Merkle root
    currentStateRoot = updateMerkleRoot(currentStateRoot, _accountIndex, account);
    
    // Transfer funds
    (bool success, ) = payable(msg.sender).call{value: _amount}("");
    require(success, "Transfer failed");
    
    emit Withdrawal(_accountIndex, msg.sender, _amount);
}

    function computeTxRoot(Transaction[] calldata _txs) internal pure returns (bytes32) {
        bytes32[] memory leaves = new bytes32[](_txs.length);
        for (uint256 i = 0; i < _txs.length; i++) {
            leaves[i] = hashTransaction(_txs[i]);
        }
        return merkleRoot(leaves);
    }

    function hashTransaction(Transaction calldata _tx) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(
            _tx.fromIndex,
            _tx.toIndex,
            _tx.amount,
            _tx.fee,
            _tx.nonce,
            _tx.signature
        ));
    }

    function merkleRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "Empty leaves");
        
        if (leaves.length == 1) {
            return leaves[0];
        }

        uint256 n = leaves.length;
        uint256 offset = 0;

        while (n > 0) {
            for (uint256 i = 0; i < n - 1; i += 2) {
                leaves[offset + i/2] = keccak256(abi.encodePacked(
                    leaves[offset + i],
                    leaves[offset + i + 1]
                ));
            }
            
            if (n % 2 == 1) {
                leaves[offset + (n-1)/2] = keccak256(abi.encodePacked(
                    leaves[offset + n - 1],
                    leaves[offset + n - 1]
                ));
            }
            
            offset += n/2;
            n = (n + 1)/2;
        }
        
        return leaves[0];
    }

    function updateMerkleRoot(
        bytes32 _root,
        uint256 _index,
        Account storage _account
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(_root, _index, _account.balance, _account.nonce));
    }

    function verifyMerkleProof(
        bytes32[] calldata _proof,
        bytes32 _root,
        uint256 _index,
        Account storage _account
    ) internal view returns (bool) {
        bytes32 leaf = keccak256(abi.encodePacked(_account.balance, _account.nonce));
        bytes32 computedRoot = processMerkleProof(_proof, leaf, _index);
        return computedRoot == _root;
    }

    function processMerkleProof(
        bytes32[] calldata _proof,
        bytes32 _leaf,
        uint256 _index
    ) internal pure returns (bytes32) {
        bytes32 computedHash = _leaf;
        uint256 index = _index;
        
        for (uint256 i = 0; i < _proof.length; i++) {
            bytes32 proofElement = _proof[i];
            
            if (index % 2 == 0) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
            
            index = index / 2;
        }
        
        return computedHash;
    }

    function calculateTotalFees(Transaction[] calldata _txs) internal pure returns (uint256) {
        uint256 totalFees = 0;
        for (uint256 i = 0; i < _txs.length; i++) {
            totalFees += _txs[i].fee;
        }
        return totalFees;
    }

    function accountOwner(uint256 _index) internal view returns (address) {
        for (address addr = address(1); addr != address(0); addr = address(uint160(addr) + 1)) {
            if (accountIndices[addr] == _index) {
                return addr;
            }
        }
        revert InvalidAccount();
    }
}