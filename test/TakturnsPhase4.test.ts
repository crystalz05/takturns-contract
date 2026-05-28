import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { TakturnsFactory, TakturnsGroup, MockUSDC } from "../typechain-types";

const USDC_DECIMALS = 1_000_000n; // 1e6
const CONTRIBUTION = 10n * USDC_DECIMALS;  // 10 USDC
const COLLATERAL = 15n * USDC_DECIMALS;    // 150% of 10 = 15 USDC
const CYCLE_DURATION = 604800;              // 1 week in seconds

describe("Phase 4: Default Resolution, Voting & Leave", function () {
  /**
   * Shared fixture: deploys factory, USDC, creates a 3-member group, and starts it.
   */
  async function activeGroupFixture() {
    const [owner, alice, bob, charlie] = await ethers.getSigners();

    // Deploy implementation
    const GroupImpl = await ethers.getContractFactory("TakturnsGroup");
    const groupImpl = await GroupImpl.deploy();

    // Deploy factory
    const Factory = await ethers.getContractFactory("TakturnsFactory");
    const factory = await Factory.deploy(await groupImpl.getAddress());

    // Deploy mock USDC
    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDCFactory.deploy();

    // Mint USDC to everyone (10000 USDC each — plenty for tests)
    const mintAmount = 10_000n * USDC_DECIMALS;
    for (const signer of [owner, alice, bob, charlie]) {
      await usdc.mint(signer.address, mintAmount);
    }

    // Create a 3-member group via factory
    const tx = await factory.createGroup(
      1,              // minGrade
      CONTRIBUTION,   // 10 USDC
      CYCLE_DURATION, // 1 week
      3,              // maxMembers
      await usdc.getAddress()
    );
    const receipt = await tx.wait();

    // Extract group address from event
    const event = receipt?.logs.find((log) => {
      try {
        return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "GroupCreated";
      } catch { return false; }
    });
    const parsedEvent = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
    const groupAddress = parsedEvent!.args[0];
    const group = GroupImpl.attach(groupAddress) as TakturnsGroup;

    // All 3 join
    for (const signer of [owner, alice, bob]) {
      await usdc.connect(signer).approve(await group.getAddress(), COLLATERAL);
      await group.connect(signer).joinGroup();
    }

    // Large approval for contributions
    const bigApproval = CONTRIBUTION * 20n;
    for (const signer of [owner, alice, bob]) {
      await usdc.connect(signer).approve(await group.getAddress(), bigApproval);
    }

    // Start the group
    await group.connect(owner).startGroup();

    return { factory, group, usdc, owner, alice, bob, charlie, groupAddress };
  }

  // ──────────────────── flagDefaulter ────────────────────

  describe("flagDefaulter", function () {
    it("should flag a member who hasn't contributed after the deadline", async function () {
      const { group, owner, alice } = await loadFixture(activeGroupFixture);

      // Owner and Alice contribute, Bob does NOT
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();

      // Fast-forward past the deadline
      await time.increase(CYCLE_DURATION + 1);

      // Anyone can flag Bob
      const bob = (await ethers.getSigners())[2];
      await expect(group.connect(owner).flagDefaulter(bob.address))
        .to.emit(group, "MemberDefaulted");
    });

    it("should reject flagging before the deadline", async function () {
      const { group, owner, bob } = await loadFixture(activeGroupFixture);

      await expect(group.connect(owner).flagDefaulter(bob.address))
        .to.be.revertedWith("TakturnsGroup: Deadline not reached");
    });

    it("should reject flagging a member who already contributed", async function () {
      const { group, owner, bob } = await loadFixture(activeGroupFixture);

      await group.connect(bob).contribute();
      await time.increase(CYCLE_DURATION + 1);

      await expect(group.connect(owner).flagDefaulter(bob.address))
        .to.be.revertedWith("TakturnsGroup: Member has contributed");
    });

    it("should reject flagging a non-member", async function () {
      const { group, owner, charlie } = await loadFixture(activeGroupFixture);

      await time.increase(CYCLE_DURATION + 1);

      await expect(group.connect(owner).flagDefaulter(charlie.address))
        .to.be.revertedWith("TakturnsGroup: Not a member");
    });

    it("should seize defaulter collateral and distribute to active members", async function () {
      const { group, owner, alice, bob } = await loadFixture(activeGroupFixture);

      // Owner and Alice contribute
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();

      await time.increase(CYCLE_DURATION + 1);

      // Flag Bob
      await group.connect(owner).flagDefaulter(bob.address);

      // Bob's collateral should be 0
      const bobInfo = await group.members(bob.address);
      expect(bobInfo.collateralDeposited).to.equal(0);
      expect(bobInfo.hasDefaulted).to.equal(true);

      // Owner and Alice each should get ~7.5 USDC extra (15/2)
      const ownerInfo = await group.members(owner.address);
      const aliceInfo = await group.members(alice.address);
      // 15 USDC / 2 = 7.5 USDC each, but integer division: 15_000_000 / 2 = 7_500_000
      expect(ownerInfo.collateralDeposited).to.equal(COLLATERAL + 7_500_000n);
      expect(aliceInfo.collateralDeposited).to.equal(COLLATERAL + 7_500_000n);
    });

    it("should blacklist the defaulter in the factory", async function () {
      const { group, factory, owner, alice, bob } = await loadFixture(activeGroupFixture);

      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await time.increase(CYCLE_DURATION + 1);

      await group.connect(owner).flagDefaulter(bob.address);

      const profile = await factory.getMemberProfile(bob.address);
      expect(profile.isBlacklisted).to.equal(true);
      expect(profile.consecutiveCompletions).to.equal(0);
    });

    it("should open voting after flagging a defaulter", async function () {
      const { group, owner, alice, bob } = await loadFixture(activeGroupFixture);

      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await time.increase(CYCLE_DURATION + 1);

      await expect(group.connect(owner).flagDefaulter(bob.address))
        .to.emit(group, "VotingOpened");

      expect(await group.votingActive()).to.equal(true);
    });

    it("should remove defaulter from collection order", async function () {
      const { group, owner, alice, bob } = await loadFixture(activeGroupFixture);

      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await time.increase(CYCLE_DURATION + 1);

      await group.connect(owner).flagDefaulter(bob.address);

      const order = await group.getCollectionOrder();
      expect(order).to.not.include(bob.address);
      expect(order.length).to.equal(2);
    });
  });

  // ──────────────────── Voting ────────────────────

  describe("Voting", function () {
    async function flaggedDefaultFixture() {
      const fixture = await activeGroupFixture();
      const { group, owner, alice, bob } = fixture;

      // Two contribute, Bob doesn't
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();

      // Fast-forward and flag
      await time.increase(CYCLE_DURATION + 1);
      await group.connect(owner).flagDefaulter(bob.address);

      return fixture;
    }

    it("should allow active members to vote", async function () {
      const { group, owner } = await loadFixture(flaggedDefaultFixture);

      await expect(group.connect(owner).vote(1)) // Continue
        .to.emit(group, "VoteCast")
        .withArgs(owner.address, 1);
    });

    it("should reject double voting", async function () {
      const { group, owner } = await loadFixture(flaggedDefaultFixture);

      await group.connect(owner).vote(1); // Continue
      await expect(group.connect(owner).vote(2))
        .to.be.revertedWith("TakturnsGroup: Already voted");
    });

    it("should reject voting from defaulted members", async function () {
      const { group, bob } = await loadFixture(flaggedDefaultFixture);

      await expect(group.connect(bob).vote(1))
        .to.be.revertedWith("TakturnsGroup: Defaulted");
    });

    it("should reject voting when no vote is active", async function () {
      const { group, owner } = await loadFixture(activeGroupFixture);

      await expect(group.connect(owner).vote(1))
        .to.be.revertedWith("TakturnsGroup: No active vote");
    });

    it("should reject resolving before supermajority", async function () {
      const { group, owner } = await loadFixture(flaggedDefaultFixture);

      // Only 1 of 2 voted — 50%, not >66%
      await group.connect(owner).vote(1);
      await expect(group.resolveVote())
        .to.be.revertedWith("TakturnsGroup: Supermajority not reached");
    });

    it("should resolve as Continue with supermajority", async function () {
      const { group, owner, alice } = await loadFixture(flaggedDefaultFixture);

      // Both active members vote Continue (2/2 = 100%)
      await group.connect(owner).vote(1);
      await group.connect(alice).vote(1);

      await expect(group.resolveVote())
        .to.emit(group, "VoteResolved")
        .withArgs(1); // Continue

      expect(await group.votingActive()).to.equal(false);
      expect(await group.state()).to.equal(1); // Still Active
    });

    it("should resolve as Dissolve with supermajority", async function () {
      const { group, usdc, owner, alice } = await loadFixture(flaggedDefaultFixture);

      // Both vote Dissolve (2/2 = 100%)
      await group.connect(owner).vote(2);
      await group.connect(alice).vote(2);

      await expect(group.resolveVote())
        .to.emit(group, "GroupDissolved");

      expect(await group.state()).to.equal(3); // Dissolved

      // Group should have no remaining funds
      const groupBalance = await usdc.balanceOf(await group.getAddress());
      expect(groupBalance).to.equal(0);
    });

    it("should refund proportionally on dissolve", async function () {
      const { group, usdc, owner, alice } = await loadFixture(flaggedDefaultFixture);

      const ownerBalanceBefore = await usdc.balanceOf(owner.address);
      const aliceBalanceBefore = await usdc.balanceOf(alice.address);

      await group.connect(owner).vote(2);
      await group.connect(alice).vote(2);
      await group.resolveVote();

      const ownerBalanceAfter = await usdc.balanceOf(owner.address);
      const aliceBalanceAfter = await usdc.balanceOf(alice.address);

      // Each should have received their share of the group's balance
      // The group held: 3 collaterals (45 USDC) + 2 contributions (20 USDC) = 65 USDC
      // But Bob's collateral was already redistributed as extra collateral, not transferred out.
      // So actual token balance = 3 * 15 (collateral) + 2 * 10 (contributions) = 65 USDC
      // Divided by 2 active members = 32.5 USDC each (32_500_000)
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(32_500_000n);
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(32_500_000n);
    });

    it("should block contributions while voting is active", async function () {
      const { group, owner } = await loadFixture(flaggedDefaultFixture);

      await expect(group.connect(owner).contribute())
        .to.be.revertedWith("TakturnsGroup: Voting in progress");
    });
  });

  // ──────────────────── Vote Continue → Resume Cycle ────────────────────

  describe("Continue after default", function () {
    it("should resume the group and allow remaining members to finish", async function () {
      const { group, usdc, owner, alice, bob } = await loadFixture(activeGroupFixture);

      // === Cycle 1: Bob defaults ===
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();

      await time.increase(CYCLE_DURATION + 1);
      await group.connect(owner).flagDefaulter(bob.address);

      // Vote Continue
      await group.connect(owner).vote(1);
      await group.connect(alice).vote(1);
      await group.resolveVote();

      // Group should still be Active
      expect(await group.state()).to.equal(1);

      // Collection order should be 2 members now
      const order = await group.getCollectionOrder();
      expect(order.length).to.equal(2);

      // The cycle may have auto-distributed if contributions matched active count.
      // Let's check: owner and alice contributed (2), active count is now 2 → should have auto-distributed!
      // So we should now be on cycle 2 or group completed depending on recipient index.
      // Let's just verify we can complete the remaining cycles.

      const currentCycle = await group.currentCycle();
      const groupState = await group.state();

      if (groupState === 1n) {
        // Still active — contribute for remaining cycles
        const remainingCycles = order.length - Number(await group.currentRecipientIndex());
        for (let c = 0; c < remainingCycles; c++) {
          // Approve more if needed
          await usdc.connect(owner).approve(await group.getAddress(), CONTRIBUTION);
          await usdc.connect(alice).approve(await group.getAddress(), CONTRIBUTION);
          await group.connect(owner).contribute();
          await group.connect(alice).contribute();
        }
      }

      // Group should be completed
      expect(await group.state()).to.equal(2); // Completed
    });
  });

  // ──────────────────── leaveGroup ────────────────────

  describe("leaveGroup", function () {
    it("should allow a member to leave during Pending and get collateral back", async function () {
      const [owner, alice, bob] = await ethers.getSigners();

      // Need a fresh group in Pending state
      const GroupImpl = await ethers.getContractFactory("TakturnsGroup");
      const groupImpl = await GroupImpl.deploy();
      const Factory = await ethers.getContractFactory("TakturnsFactory");
      const factory = await Factory.deploy(await groupImpl.getAddress());
      const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDCFactory.deploy();

      await usdc.mint(owner.address, 10_000n * USDC_DECIMALS);
      await usdc.mint(alice.address, 10_000n * USDC_DECIMALS);

      const tx = await factory.createGroup(1, CONTRIBUTION, CYCLE_DURATION, 3, await usdc.getAddress());
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "GroupCreated";
        } catch { return false; }
      });
      const parsedEvent = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
      const group = GroupImpl.attach(parsedEvent!.args[0]) as TakturnsGroup;

      await usdc.connect(owner).approve(await group.getAddress(), COLLATERAL);
      await group.connect(owner).joinGroup();
      await usdc.connect(alice).approve(await group.getAddress(), COLLATERAL);
      await group.connect(alice).joinGroup();

      const balanceBefore = await usdc.balanceOf(alice.address);

      await expect(group.connect(alice).leaveGroup())
        .to.emit(group, "MemberLeft")
        .withArgs(alice.address, COLLATERAL);

      const balanceAfter = await usdc.balanceOf(alice.address);
      expect(balanceAfter - balanceBefore).to.equal(COLLATERAL);
    });

    it("should allow a member to leave during Active (before receiving payout)", async function () {
      const { group, usdc, alice } = await loadFixture(activeGroupFixture);

      const balanceBefore = await usdc.balanceOf(alice.address);

      await expect(group.connect(alice).leaveGroup())
        .to.emit(group, "MemberLeft");

      const balanceAfter = await usdc.balanceOf(alice.address);
      // Should get collateral back
      expect(balanceAfter - balanceBefore).to.equal(COLLATERAL);
    });

    it("should reject leave after receiving a payout", async function () {
      const { group, owner, alice, bob } = await loadFixture(activeGroupFixture);

      // Complete cycle 1 — someone gets a payout
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await group.connect(bob).contribute();

      // Find who received the payout
      const collectionOrder = await group.getCollectionOrder();
      const recipient = collectionOrder[0];
      const recipientSigner = [owner, alice, bob].find(s => s.address === recipient)!;

      // Recipient tries to leave → should fail
      await expect(group.connect(recipientSigner).leaveGroup())
        .to.be.revertedWith("TakturnsGroup: Cannot leave after receiving payout");
    });

    it("should reject leave from non-member", async function () {
      const { group, charlie } = await loadFixture(activeGroupFixture);

      await expect(group.connect(charlie).leaveGroup())
        .to.be.revertedWith("TakturnsGroup: Not a member");
    });
  });

  // ──────────────────── emergencyRefund ────────────────────

  describe("emergencyRefund", function () {
    it("should allow admin to emergency refund during Active", async function () {
      const { group, usdc, owner, alice, bob } = await loadFixture(activeGroupFixture);

      await expect(group.connect(owner).emergencyRefund())
        .to.emit(group, "EmergencyRefund")
        .to.emit(group, "GroupDissolved");

      expect(await group.state()).to.equal(3); // Dissolved

      // Group should have no remaining funds
      const groupBalance = await usdc.balanceOf(await group.getAddress());
      expect(groupBalance).to.equal(0);
    });

    it("should reject emergency refund from non-admin", async function () {
      const { group, alice } = await loadFixture(activeGroupFixture);

      await expect(group.connect(alice).emergencyRefund())
        .to.be.revertedWith("TakturnsGroup: Caller is not admin");
    });

    it("should distribute funds equally to all active members", async function () {
      const { group, usdc, owner, alice, bob } = await loadFixture(activeGroupFixture);

      // Group holds: 3 * 15 USDC collateral = 45 USDC
      const expectedShare = 45n * USDC_DECIMALS / 3n; // 15 USDC each

      const ownerBefore = await usdc.balanceOf(owner.address);
      const aliceBefore = await usdc.balanceOf(alice.address);
      const bobBefore = await usdc.balanceOf(bob.address);

      await group.connect(owner).emergencyRefund();

      const ownerAfter = await usdc.balanceOf(owner.address);
      const aliceAfter = await usdc.balanceOf(alice.address);
      const bobAfter = await usdc.balanceOf(bob.address);

      expect(ownerAfter - ownerBefore).to.equal(expectedShare);
      expect(aliceAfter - aliceBefore).to.equal(expectedShare);
      expect(bobAfter - bobBefore).to.equal(expectedShare);
    });

    it("should reject emergency refund when group is Completed", async function () {
      const { group, owner, alice, bob } = await loadFixture(activeGroupFixture);

      // Complete all 3 cycles
      for (let c = 0; c < 3; c++) {
        await group.connect(owner).contribute();
        await group.connect(alice).contribute();
        await group.connect(bob).contribute();
      }

      expect(await group.state()).to.equal(2); // Completed
      await expect(group.connect(owner).emergencyRefund())
        .to.be.revertedWith("TakturnsGroup: Cannot emergency refund in current state");
    });
  });

  // ──────────────────── Supermajority Edge Cases ────────────────────

  describe("Supermajority threshold edge cases", function () {
    it("2 of 3 original members (2 active after default) = both must vote for supermajority", async function () {
      const { group, owner, alice, bob } = await loadFixture(activeGroupFixture);

      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await time.increase(CYCLE_DURATION + 1);
      await group.connect(owner).flagDefaulter(bob.address);

      // 1 of 2 votes → 50% → not supermajority
      await group.connect(owner).vote(1);
      await expect(group.resolveVote())
        .to.be.revertedWith("TakturnsGroup: Supermajority not reached");

      // 2 of 2 votes → 100% → supermajority
      await group.connect(alice).vote(1);
      await expect(group.resolveVote()).to.not.be.reverted;
    });
  });

  // ──────────────────── getVotingStatus ────────────────────

  describe("getVotingStatus", function () {
    it("should return correct voting status", async function () {
      const { group, owner, alice, bob } = await loadFixture(activeGroupFixture);

      // Before default
      let status = await group.getVotingStatus();
      expect(status.isActive).to.equal(false);
      expect(status.forContinue).to.equal(0);
      expect(status.forDissolve).to.equal(0);

      // Flag default and vote
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await time.increase(CYCLE_DURATION + 1);
      await group.connect(owner).flagDefaulter(bob.address);

      status = await group.getVotingStatus();
      expect(status.isActive).to.equal(true);
      expect(status.activeMembers).to.equal(2);

      await group.connect(owner).vote(1);
      status = await group.getVotingStatus();
      expect(status.forContinue).to.equal(1);
      expect(status.forDissolve).to.equal(0);
    });
  });
});
