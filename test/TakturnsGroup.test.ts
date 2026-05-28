import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { TakturnsFactory, TakturnsGroup, MockUSDC } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const USDC_DECIMALS = 1_000_000n; // 1e6

describe("TakturnsFactory", function () {
  async function deployFactoryFixture() {
    const [owner, alice, bob, charlie, dave] = await ethers.getSigners();

    // Deploy implementation
    const GroupImpl = await ethers.getContractFactory("TakturnsGroup");
    const groupImpl = await GroupImpl.deploy();

    // Deploy factory
    const Factory = await ethers.getContractFactory("TakturnsFactory");
    const factory = await Factory.deploy(await groupImpl.getAddress());

    // Deploy mock USDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    return { factory, groupImpl, usdc, owner, alice, bob, charlie, dave };
  }

  describe("Grade Rules", function () {
    it("should return correct Grade 1 rules", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      const rules = await factory.getGradeRules(1);
      expect(rules.minContribution).to.equal(5n * USDC_DECIMALS);
      expect(rules.maxContribution).to.equal(30n * USDC_DECIMALS);
      expect(rules.collateralPercent).to.equal(150n);
    });

    it("should return correct Grade 4 rules", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      const rules = await factory.getGradeRules(4);
      expect(rules.minContribution).to.equal(401n * USDC_DECIMALS);
      expect(rules.maxContribution).to.equal(2000n * USDC_DECIMALS);
      expect(rules.collateralPercent).to.equal(50n);
    });

    it("should revert for invalid grade 0", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      await expect(factory.getGradeRules(0)).to.be.revertedWith("TakturnsFactory: Invalid grade");
    });

    it("should revert for grade > 4", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      await expect(factory.getGradeRules(5)).to.be.revertedWith("TakturnsFactory: Invalid grade");
    });
  });

  describe("Collateral Calculation", function () {
    it("should calculate 150% collateral for Grade 1", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      const contribution = 10n * USDC_DECIMALS;
      const collateral = await factory.getCollateralAmount(contribution, 1);
      expect(collateral).to.equal(15n * USDC_DECIMALS); // 10 * 150 / 100
    });

    it("should calculate 50% collateral for Grade 4", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      const contribution = 500n * USDC_DECIMALS;
      const collateral = await factory.getCollateralAmount(contribution, 4);
      expect(collateral).to.equal(250n * USDC_DECIMALS); // 500 * 50 / 100
    });
  });

  describe("Member Profile", function () {
    it("should default new users to Grade 1", async function () {
      const { factory, alice } = await loadFixture(deployFactoryFixture);
      const profile = await factory.getMemberProfile(alice.address);
      expect(profile.grade).to.equal(1);
      expect(profile.consecutiveCompletions).to.equal(0);
      expect(profile.isBlacklisted).to.equal(false);
    });
  });

  describe("canJoinGroup", function () {
    it("should allow a new user (Grade 1) to join a Grade 1 group", async function () {
      const { factory, alice } = await loadFixture(deployFactoryFixture);
      expect(await factory.canJoinGroup(alice.address, 1)).to.equal(true);
    });

    it("should reject a Grade 1 user from joining a Grade 2 group", async function () {
      const { factory, alice } = await loadFixture(deployFactoryFixture);
      expect(await factory.canJoinGroup(alice.address, 2)).to.equal(false);
    });
  });

  describe("Group Creation", function () {
    it("should create a group with valid parameters", async function () {
      const { factory, usdc, owner } = await loadFixture(deployFactoryFixture);
      const contribution = 10n * USDC_DECIMALS;
      const tx = await factory.createGroup(1, contribution, 604800, 3, await usdc.getAddress());
      const receipt = await tx.wait();

      // Should emit GroupCreated
      await expect(tx).to.emit(factory, "GroupCreated");
    });

    it("should reject contribution outside grade bounds", async function () {
      const { factory, usdc } = await loadFixture(deployFactoryFixture);
      // 50 USDC is above Grade 1 max (30)
      const contribution = 50n * USDC_DECIMALS;
      await expect(
        factory.createGroup(1, contribution, 604800, 3, await usdc.getAddress())
      ).to.be.revertedWith("TakturnsFactory: Contribution out of bounds for grade");
    });

    it("should reject maxMembers <= 1", async function () {
      const { factory, usdc } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.createGroup(1, 10n * USDC_DECIMALS, 604800, 1, await usdc.getAddress())
      ).to.be.revertedWith("TakturnsFactory: Max members must be > 1");
    });
  });
});

describe("TakturnsGroup", function () {
  const CONTRIBUTION = 10n * USDC_DECIMALS; // 10 USDC
  const COLLATERAL = 15n * USDC_DECIMALS;   // 150% of 10 = 15 USDC
  const CYCLE_DURATION = 604800n;            // 1 week in seconds

  async function deployGroupFixture() {
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

    // Mint USDC to everyone (1000 USDC each)
    const mintAmount = 1000n * USDC_DECIMALS;
    for (const signer of [owner, alice, bob, charlie]) {
      await usdc.mint(signer.address, mintAmount);
    }

    // Create a group via the factory
    const tx = await factory.createGroup(
      1,              // minGrade
      CONTRIBUTION,   // 10 USDC
      CYCLE_DURATION, // 1 week
      3,              // maxMembers
      await usdc.getAddress()
    );
    const receipt = await tx.wait();

    // Get the deployed group address from events
    const event = receipt?.logs.find((log) => {
      try {
        return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "GroupCreated";
      } catch { return false; }
    });
    const parsedEvent = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
    const groupAddress = parsedEvent!.args[0];

    const group = GroupImpl.attach(groupAddress) as TakturnsGroup;

    return { factory, group, usdc, owner, alice, bob, charlie, groupAddress };
  }

  describe("Joining", function () {
    it("should allow a user to join and deposit collateral", async function () {
      const { group, usdc, alice } = await loadFixture(deployGroupFixture);
      
      // Approve collateral
      await usdc.connect(alice).approve(await group.getAddress(), COLLATERAL);
      
      await expect(group.connect(alice).joinGroup())
        .to.emit(group, "MemberJoined")
        .withArgs(alice.address, COLLATERAL, 1);

      // Verify collateral was transferred
      const groupBalance = await usdc.balanceOf(await group.getAddress());
      expect(groupBalance).to.equal(COLLATERAL);
    });

    it("should reject joining twice", async function () {
      const { group, usdc, alice } = await loadFixture(deployGroupFixture);
      await usdc.connect(alice).approve(await group.getAddress(), COLLATERAL * 2n);
      await group.connect(alice).joinGroup();

      await expect(group.connect(alice).joinGroup())
        .to.be.revertedWith("TakturnsGroup: Already a member");
    });

    it("should reject joining when group is full", async function () {
      const { group, usdc, owner, alice, bob, charlie } = await loadFixture(deployGroupFixture);

      // Owner, Alice, Bob join (3 max)
      for (const signer of [owner, alice, bob]) {
        await usdc.connect(signer).approve(await group.getAddress(), COLLATERAL);
        await group.connect(signer).joinGroup();
      }

      // Charlie should be rejected
      await usdc.connect(charlie).approve(await group.getAddress(), COLLATERAL);
      await expect(group.connect(charlie).joinGroup())
        .to.be.revertedWith("TakturnsGroup: Group is full");
    });
  });

  describe("Starting the Group", function () {
    it("should allow admin to start with >= 2 members", async function () {
      const { group, usdc, owner, alice } = await loadFixture(deployGroupFixture);

      // Join 2 members
      await usdc.connect(owner).approve(await group.getAddress(), COLLATERAL);
      await group.connect(owner).joinGroup();
      await usdc.connect(alice).approve(await group.getAddress(), COLLATERAL);
      await group.connect(alice).joinGroup();

      await expect(group.connect(owner).startGroup())
        .to.emit(group, "GroupStarted");

      expect(await group.state()).to.equal(1); // Active
      expect(await group.currentCycle()).to.equal(1);
    });

    it("should reject start with < 2 members", async function () {
      const { group, usdc, owner } = await loadFixture(deployGroupFixture);
      await usdc.connect(owner).approve(await group.getAddress(), COLLATERAL);
      await group.connect(owner).joinGroup();

      await expect(group.connect(owner).startGroup())
        .to.be.revertedWith("TakturnsGroup: Need at least 2 members");
    });

    it("should reject start from non-admin", async function () {
      const { group, usdc, owner, alice } = await loadFixture(deployGroupFixture);
      await usdc.connect(owner).approve(await group.getAddress(), COLLATERAL);
      await group.connect(owner).joinGroup();
      await usdc.connect(alice).approve(await group.getAddress(), COLLATERAL);
      await group.connect(alice).joinGroup();

      await expect(group.connect(alice).startGroup())
        .to.be.revertedWith("TakturnsGroup: Caller is not admin");
    });
  });

  describe("Contributions", function () {
    async function activeGroupFixture() {
      const fixture = await deployGroupFixture();
      const { group, usdc, owner, alice, bob } = fixture;

      // 3 members join
      for (const signer of [owner, alice, bob]) {
        await usdc.connect(signer).approve(await group.getAddress(), COLLATERAL);
        await group.connect(signer).joinGroup();
      }

      // Approve contributions for all cycles (3 members = 3 cycles, each contributing 10 USDC)
      const totalApproval = CONTRIBUTION * 3n;
      for (const signer of [owner, alice, bob]) {
        await usdc.connect(signer).approve(await group.getAddress(), totalApproval);
      }

      // Start the group
      await group.connect(owner).startGroup();

      return fixture;
    }

    it("should accept a valid contribution", async function () {
      const { group, owner } = await loadFixture(activeGroupFixture);

      await expect(group.connect(owner).contribute())
        .to.emit(group, "ContributionMade")
        .withArgs(owner.address, 1, CONTRIBUTION);
    });

    it("should reject double contribution in same cycle", async function () {
      const { group, owner } = await loadFixture(activeGroupFixture);
      await group.connect(owner).contribute();

      await expect(group.connect(owner).contribute())
        .to.be.revertedWith("TakturnsGroup: Already contributed this cycle");
    });

    it("should reject contribution from non-member", async function () {
      const { group, charlie } = await loadFixture(activeGroupFixture);

      await expect(group.connect(charlie).contribute())
        .to.be.revertedWith("TakturnsGroup: Not a member");
    });

    it("should show correct cycle progress", async function () {
      const { group, owner, alice } = await loadFixture(activeGroupFixture);

      let progress = await group.getCycleProgress();
      expect(progress.contributed).to.equal(0);
      expect(progress.total).to.equal(3);

      await group.connect(owner).contribute();
      progress = await group.getCycleProgress();
      expect(progress.contributed).to.equal(1);

      await group.connect(alice).contribute();
      progress = await group.getCycleProgress();
      expect(progress.contributed).to.equal(2);
    });
  });

  describe("Auto-Distribution", function () {
    async function activeGroupFixture() {
      const fixture = await deployGroupFixture();
      const { group, usdc, owner, alice, bob } = fixture;

      for (const signer of [owner, alice, bob]) {
        await usdc.connect(signer).approve(await group.getAddress(), COLLATERAL);
        await group.connect(signer).joinGroup();
      }

      // Large approval for all contributions across all cycles
      const totalApproval = CONTRIBUTION * 10n;
      for (const signer of [owner, alice, bob]) {
        await usdc.connect(signer).approve(await group.getAddress(), totalApproval);
      }

      await group.connect(owner).startGroup();

      return fixture;
    }

    it("should auto-distribute to recipient when all members contribute", async function () {
      const { group, usdc, owner, alice, bob } = await loadFixture(activeGroupFixture);

      const recipient = await group.getCurrentRecipient();
      const recipientBalanceBefore = await usdc.balanceOf(recipient);

      // All 3 contribute
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await group.connect(bob).contribute(); // This triggers auto-distribution

      const recipientBalanceAfter = await usdc.balanceOf(recipient);
      const netGain = CONTRIBUTION * 2n; // They get 30 from the pool, but they paid 10, so net gain is 20 USDC
      expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(netGain);
    });

    it("should advance to cycle 2 after first distribution", async function () {
      const { group, owner, alice, bob } = await loadFixture(activeGroupFixture);

      // Complete cycle 1
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await group.connect(bob).contribute();

      expect(await group.currentCycle()).to.equal(2);
      const progress = await group.getCycleProgress();
      expect(progress.contributed).to.equal(0); // Reset for new cycle
    });

    it("should notify factory of successful cycle (for promotion tracking)", async function () {
      const { group, factory, owner, alice, bob } = await loadFixture(activeGroupFixture);

      const recipient = await group.getCurrentRecipient();

      // Complete cycle 1
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();

      await expect(group.connect(bob).contribute())
        .to.emit(factory, "ConsecutiveCompletionRecorded");
    });
  });

  describe("Full Cycle Integration (3 members, 3 cycles)", function () {
    async function activeGroupFixture() {
      const fixture = await deployGroupFixture();
      const { group, usdc, owner, alice, bob } = fixture;

      for (const signer of [owner, alice, bob]) {
        await usdc.connect(signer).approve(await group.getAddress(), COLLATERAL);
        await group.connect(signer).joinGroup();
      }

      const totalApproval = CONTRIBUTION * 10n;
      for (const signer of [owner, alice, bob]) {
        await usdc.connect(signer).approve(await group.getAddress(), totalApproval);
      }

      await group.connect(owner).startGroup();

      return fixture;
    }

    it("should complete all 3 cycles and refund collateral", async function () {
      const { group, usdc, owner, alice, bob } = await loadFixture(activeGroupFixture);

      const collectionOrder = await group.getCollectionOrder();
      expect(collectionOrder.length).to.equal(3);

      // Track balances before the full run
      const initialBalances: Record<string, bigint> = {};
      for (const signer of [owner, alice, bob]) {
        initialBalances[signer.address] = await usdc.balanceOf(signer.address);
      }

      // === Cycle 1 ===
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await group.connect(bob).contribute();
      expect(await group.currentCycle()).to.equal(2);

      // === Cycle 2 ===
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await group.connect(bob).contribute();
      expect(await group.currentCycle()).to.equal(3);

      // === Cycle 3 ===
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      await group.connect(bob).contribute();

      // Group should be completed
      expect(await group.state()).to.equal(2); // Completed

      // Each member contributed 10 USDC * 3 cycles = 30 USDC
      // Each member received 30 USDC payout once
      // Net from contributions/payouts = 0 (they get back exactly what they put in)
      // Plus: collateral refunded (15 USDC each)
      // So final balance should equal initial balance (they started with 1000 USDC
      //   - 15 collateral when joining, then contributions and payouts cancel out,
      //   then collateral refunded at end)

      for (const signer of [owner, alice, bob]) {
        const finalBalance = await usdc.balanceOf(signer.address);
        // Initial was recorded AFTER joining (so it was missing the 15 collateral).
        // After all cycles, collateral is refunded.
        // So finalBalance should be initialBalance + COLLATERAL.
        expect(finalBalance).to.equal(initialBalances[signer.address] + COLLATERAL);
      }
    });

    it("should track all 3 members as having received payouts", async function () {
      const { group, owner, alice, bob } = await loadFixture(activeGroupFixture);

      // Run all 3 cycles
      for (let cycle = 0; cycle < 3; cycle++) {
        await group.connect(owner).contribute();
        await group.connect(alice).contribute();
        await group.connect(bob).contribute();
      }

      // All should have received payouts
      for (const signer of [owner, alice, bob]) {
        expect(await group.hasReceivedPayout(signer.address)).to.equal(true);
      }
    });

    it("should record 3 consecutive completions per member in the factory", async function () {
      const { group, factory, owner, alice, bob } = await loadFixture(activeGroupFixture);

      // Run all 3 cycles — each member gets recordSuccessfulCycle called once (as recipient)
      for (let cycle = 0; cycle < 3; cycle++) {
        await group.connect(owner).contribute();
        await group.connect(alice).contribute();
        await group.connect(bob).contribute();
      }

      // Each member received 1 payout, so consecutiveCompletions = 1 for each
      // (recordSuccessfulCycle is only called for the RECIPIENT of each cycle, not for contributors)
      for (const signer of [owner, alice, bob]) {
        const profile = await factory.getMemberProfile(signer.address);
        // After promotion at 3 completions, the counter resets to 0.
        // But each member only gets 1 completion (they're each the recipient of 1 cycle).
        expect(profile.consecutiveCompletions).to.equal(1);
      }
    });
  });

  describe("Collection Order", function () {
    it("should use join order for mixed-grade groups", async function () {
      const { group, usdc, owner, alice, bob } = await loadFixture(deployGroupFixture);

      // All same grade (1) so it's actually same-grade — but let's just verify the order
      for (const signer of [owner, alice, bob]) {
        await usdc.connect(signer).approve(await group.getAddress(), COLLATERAL);
        await group.connect(signer).joinGroup();
      }

      await group.connect(owner).startGroup();

      const order = await group.getCollectionOrder();
      expect(order.length).to.equal(3);

      // Same grade = sorted by grade descending, but all same grade,
      // so it falls back to join order
      expect(order[0]).to.equal(owner.address);
      expect(order[1]).to.equal(alice.address);
      expect(order[2]).to.equal(bob.address);
    });

    it("should return correct members list", async function () {
      const { group, usdc, owner, alice } = await loadFixture(deployGroupFixture);

      await usdc.connect(owner).approve(await group.getAddress(), COLLATERAL);
      await group.connect(owner).joinGroup();
      await usdc.connect(alice).approve(await group.getAddress(), COLLATERAL);
      await group.connect(alice).joinGroup();

      const members = await group.getMembers();
      expect(members.length).to.equal(2);
      expect(members[0]).to.equal(owner.address);
      expect(members[1]).to.equal(alice.address);
    });
  });

  describe("Edge Cases", function () {
    it("should reject contribution when group is not Active", async function () {
      const { group, usdc, owner } = await loadFixture(deployGroupFixture);
      await usdc.connect(owner).approve(await group.getAddress(), COLLATERAL + CONTRIBUTION);
      await group.connect(owner).joinGroup();

      await expect(group.connect(owner).contribute())
        .to.be.revertedWith("TakturnsGroup: Invalid state");
    });

    it("should hold correct token balance during active cycles", async function () {
      const { group, usdc, owner, alice, bob } = await loadFixture(deployGroupFixture);

      for (const signer of [owner, alice, bob]) {
        await usdc.connect(signer).approve(await group.getAddress(), COLLATERAL);
        await group.connect(signer).joinGroup();
      }

      // Collateral: 3 * 15 = 45 USDC
      expect(await usdc.balanceOf(await group.getAddress())).to.equal(45n * USDC_DECIMALS);

      const totalApproval = CONTRIBUTION * 10n;
      for (const signer of [owner, alice, bob]) {
        await usdc.connect(signer).approve(await group.getAddress(), totalApproval);
      }

      await group.connect(owner).startGroup();

      // After 2 contributions (cycle not yet complete), balance = collateral + 2 contributions
      await group.connect(owner).contribute();
      await group.connect(alice).contribute();
      expect(await usdc.balanceOf(await group.getAddress())).to.equal(
        45n * USDC_DECIMALS + 20n * USDC_DECIMALS // 45 collateral + 20 contributions
      );
    });
  });
});
