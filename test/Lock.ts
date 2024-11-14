import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import hre from "hardhat";
import { ethers } from "hardhat";

describe("ProductionZkRollup", function () {
  async function deployZkRollupFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

    const ZkRollup = await ethers.getContractFactory("ProductionZkRollup");
    const zkRollup = await ZkRollup.deploy();

    // Create a sample public key hash
    const pubKeyHash = ethers.keccak256(
      ethers.solidityPacked(
        ["string"],
        ["sample-public-key"]
      )
    );

    return { zkRollup, owner, user1, user2, pubKeyHash };
  }

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      const { zkRollup, owner } = await loadFixture(deployZkRollupFixture);
      expect(await zkRollup.owner()).to.equal(owner.address);
    });

    it("Should start with zero accounts", async function () {
      const { zkRollup } = await loadFixture(deployZkRollupFixture);
      expect(await zkRollup.totalAccounts()).to.equal(0);
    });

    it("Should start unpaused", async function () {
      const { zkRollup } = await loadFixture(deployZkRollupFixture);
      expect(await zkRollup.paused()).to.equal(false);
    });
  });

  describe("Account Management", function () {
    it("Should create a new account", async function () {
      const { zkRollup, user1, pubKeyHash } = await loadFixture(deployZkRollupFixture);

      await expect(zkRollup.connect(user1).createAccount(pubKeyHash))
        .to.emit(zkRollup, "AccountCreated")
        .withArgs(1, user1.address, pubKeyHash);

      const accountIndex = await zkRollup.accountIndices(user1.address);
      expect(accountIndex).to.equal(1);
    });

    it("Should prevent duplicate accounts", async function () {
      const { zkRollup, user1, pubKeyHash } = await loadFixture(deployZkRollupFixture);

      await zkRollup.connect(user1).createAccount(pubKeyHash);
      await expect(zkRollup.connect(user1).createAccount(pubKeyHash))
        .to.be.revertedWith("Account already exists");
    });

    it("Should initialize account with zero balance", async function () {
      const { zkRollup, user1, pubKeyHash } = await loadFixture(deployZkRollupFixture);

      await zkRollup.connect(user1).createAccount(pubKeyHash);
      const accountIndex = await zkRollup.accountIndices(user1.address);
      const account = await zkRollup.accounts(accountIndex);
      
      expect(account.balance).to.equal(0);
      expect(account.nonce).to.equal(0);
      expect(account.pubKeyHash).to.equal(pubKeyHash);
    });
  });

  describe("Deposits", function () {
    it("Should accept deposits to valid accounts", async function () {
      const { zkRollup, user1, pubKeyHash } = await loadFixture(deployZkRollupFixture);
      const depositAmount = ethers.parseEther("1.0");

      await zkRollup.connect(user1).createAccount(pubKeyHash);
      const accountIndex = await zkRollup.accountIndices(user1.address);

      await expect(zkRollup.connect(user1).deposit(accountIndex, { value: depositAmount }))
        .to.emit(zkRollup, "Deposit")
        .withArgs(accountIndex, depositAmount);

      const account = await zkRollup.accounts(accountIndex);
      expect(account.balance).to.equal(depositAmount);
    });

    it("Should reject deposits to invalid accounts", async function () {
      const { zkRollup, user1 } = await loadFixture(deployZkRollupFixture);
      const depositAmount = ethers.parseEther("1.0");

      await expect(zkRollup.connect(user1).deposit(999, { value: depositAmount }))
        .to.be.revertedWithCustomError(zkRollup, "InvalidAccount");
    });

    it("Should reject zero deposits", async function () {
      const { zkRollup, user1, pubKeyHash } = await loadFixture(deployZkRollupFixture);

      await zkRollup.connect(user1).createAccount(pubKeyHash);
      const accountIndex = await zkRollup.accountIndices(user1.address);

      await expect(zkRollup.connect(user1).deposit(accountIndex, { value: 0 }))
        .to.be.revertedWithCustomError(zkRollup, "InvalidAmount");
    });
  });

  describe("Batch Processing", function () {
    it("Should process valid transaction batch", async function () {
      const { zkRollup, owner, user1, user2, pubKeyHash } = await loadFixture(deployZkRollupFixture);
      
      // Create accounts
      await zkRollup.connect(user1).createAccount(pubKeyHash);
      await zkRollup.connect(user2).createAccount(pubKeyHash);
      
      const account1Index = await zkRollup.accountIndices(user1.address);
      const account2Index = await zkRollup.accountIndices(user2.address);
      
      // Fund account1
      await zkRollup.connect(user1).deposit(account1Index, { value: ethers.parseEther("2.0") });

      const transactions = [{
        fromIndex: account1Index,
        toIndex: account2Index,
        amount: ethers.parseEther("1.0"),
        fee: ethers.parseEther("0.01"),
        nonce: 0,
        signature: "0x",
      }];

      const newStateRoot = ethers.keccak256(ethers.solidityPacked(["string"], ["new-state"]));

      await expect(zkRollup.connect(owner).submitBatch(transactions, newStateRoot))
        .to.emit(zkRollup, "BatchSubmitted")
        .withArgs(0, newStateRoot, anyValue);
    });

    it("Should reject oversized batches", async function () {
      const { zkRollup, owner } = await loadFixture(deployZkRollupFixture);
      
      const transactions = Array(33).fill({
        fromIndex: 1,
        toIndex: 2,
        amount: ethers.parseEther("1.0"),
        fee: ethers.parseEther("0.01"),
        nonce: 0,
        signature: "0x",
      });

      const newStateRoot = ethers.keccak256(ethers.solidityPacked(["string"], ["new-state"]));

      await expect(zkRollup.connect(owner).submitBatch(transactions, newStateRoot))
        .to.be.revertedWith("Batch too large");
    });

    it("Should only allow owner to submit batches", async function () {
      const { zkRollup, user1 } = await loadFixture(deployZkRollupFixture);
      
      const transactions = [{
        fromIndex: 1,
        toIndex: 2,
        amount: ethers.parseEther("1.0"),
        fee: ethers.parseEther("0.01"),
        nonce: 0,
        signature: "0x",
      }];

      const newStateRoot = ethers.keccak256(ethers.solidityPacked(["string"], ["new-state"]));

      await expect(zkRollup.connect(user1).submitBatch(transactions, newStateRoot))
        .to.be.revertedWithCustomError(zkRollup, "NotOwner");
    });
  });

  describe("Withdrawals", function () {
    // it("Should process valid withdrawals", async function () {
    //   const { zkRollup, user1, pubKeyHash } = await loadFixture(deployZkRollupFixture);
    //   const depositAmount = ethers.parseEther("2.0");
    //   const withdrawAmount = ethers.parseEther("1.0");

    //   // Create and fund account
    //   await zkRollup.connect(user1).createAccount(pubKeyHash);
    //   const accountIndex = await zkRollup.accountIndices(user1.address);
    //   await zkRollup.connect(user1).deposit(accountIndex, { value: depositAmount });

    //   // Create merkle proof (simplified for testing)
    //   const merkleProof: string[] = [];

    //   await expect(zkRollup.connect(user1).withdraw(accountIndex, withdrawAmount, merkleProof))
    //     .to.emit(zkRollup, "Withdrawal")
    //     .withArgs(accountIndex, user1.address, withdrawAmount);

    //   const account = await zkRollup.accounts(accountIndex);
    //   expect(account.balance).to.equal(depositAmount - withdrawAmount);
    // });

    // it("Should reject withdrawals exceeding balance", async function () {
    //   const { zkRollup, user1, pubKeyHash } = await loadFixture(deployZkRollupFixture);
      
    //   await zkRollup.connect(user1).createAccount(pubKeyHash);
    //   const accountIndex = await zkRollup.accountIndices(user1.address);
    //   await zkRollup.connect(user1).deposit(accountIndex, { value: ethers.parseEther("1.0") });

    //   const merkleProof: string[] = []; 
      
    //   await expect(zkRollup.connect(user1).withdraw(
    //     accountIndex,
    //     ethers.parseEther("2.0"),
    //     merkleProof
    //   )).to.be.revertedWithCustomError(zkRollup, "InsufficientBalance");
    // });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to pause and unpause", async function () {
      const { zkRollup, owner } = await loadFixture(deployZkRollupFixture);

      await expect(zkRollup.connect(owner).pause())
        .to.emit(zkRollup, "Paused")
        .withArgs(owner.address);

      expect(await zkRollup.paused()).to.be.true;

      await expect(zkRollup.connect(owner).unpause())
        .to.emit(zkRollup, "Unpaused")
        .withArgs(owner.address);

      expect(await zkRollup.paused()).to.be.false;
    });

    it("Should prevent non-owners from pausing", async function () {
      const { zkRollup, user1 } = await loadFixture(deployZkRollupFixture);

      await expect(zkRollup.connect(user1).pause())
        .to.be.revertedWithCustomError(zkRollup, "NotOwner");
    });

    it("Should allow owner to transfer ownership", async function () {
      const { zkRollup, owner, user1 } = await loadFixture(deployZkRollupFixture);

      await expect(zkRollup.connect(owner).transferOwnership(user1.address))
        .to.emit(zkRollup, "OwnershipTransferred")
        .withArgs(owner.address, user1.address);

      expect(await zkRollup.owner()).to.equal(user1.address);
    });

    it("Should prevent transferring ownership to zero address", async function () {
      const { zkRollup, owner } = await loadFixture(deployZkRollupFixture);

      await expect(zkRollup.connect(owner).transferOwnership(ethers.ZeroAddress))
        .to.be.revertedWith("New owner is the zero address");
    });
  });
});