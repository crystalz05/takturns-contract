import { ethers } from "hardhat";

/**
 * Demo script: End-to-end rotating savings cycle on a local or testnet network.
 *
 * Demonstrates:
 *   1. Factory deployment
 *   2. Group creation (Grade 1, 10 USDC/cycle, 3 members)
 *   3. Members join (15 USDC collateral each)
 *   4. Admin starts the group
 *   5. Cycle 1 & 2: all contribute → auto-distribution
 *   6. Cycle 3: one member defaults → flagging, collateral seizure, voting
 *   7. Final balance & blacklist status report
 *
 * Usage:
 *   npx hardhat run scripts/demo-cycle.ts                        # local hardhat node
 *   npx hardhat run scripts/demo-cycle.ts --network arbitrumSepolia  # testnet
 */

const USDC_DECIMALS = 1_000_000n;
const CONTRIBUTION = 10n * USDC_DECIMALS;    // 10 USDC
const COLLATERAL   = 15n * USDC_DECIMALS;    // 150% of 10 = 15 USDC
const CYCLE_DURATION = 60;                    // 60 seconds for demo speed (1 week on prod)

// Circle Testnet USDC on Arbitrum Sepolia
const CIRCLE_USDC_ARBITRUM_SEPOLIA = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

async function main() {
  const signers = await ethers.getSigners();
  const isLocal = (await ethers.provider.getNetwork()).chainId === 31337n;

  if (signers.length < 3 && !isLocal) {
    console.error("❌ ERROR: Running the demo on a testnet requires 3 wallets.");
    console.error("Please add 2 more private keys to the 'accounts' array in hardhat.config.ts,");
    console.error("or simply test the protocol via your frontend application using the verified contracts.");
    console.error("The local demo (`npm run demo`) works automatically because Hardhat provides 20 test accounts.");
    process.exit(1);
  }

  const deployer = signers[0];
  const alice = signers[1];
  const bob = signers[2];

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              TAKTURNS — Demo Cycle Script                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`Network:    ${isLocal ? "Hardhat (local)" : "Arbitrum Sepolia"}`);
  console.log(`Deployer:   ${deployer.address}`);
  console.log(`Alice:      ${alice.address}`);
  console.log(`Bob:        ${bob.address}`);
  console.log();

  // ─── Step 1: Deploy or use existing USDC ────────────────────────────
  let usdcAddress: string;

  if (isLocal) {
    console.log("📦 Deploying MockUSDC for local testing...");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    usdcAddress = await usdc.getAddress();

    // Mint USDC to all participants
    const mintAmount = 1_000n * USDC_DECIMALS;
    await usdc.mint(deployer.address, mintAmount);
    await usdc.mint(alice.address, mintAmount);
    await usdc.mint(bob.address, mintAmount);
    console.log(`   Minted ${mintAmount / USDC_DECIMALS} USDC to each participant`);
  } else {
    usdcAddress = CIRCLE_USDC_ARBITRUM_SEPOLIA;
    console.log(`📦 Using Circle Testnet USDC: ${usdcAddress}`);
  }
  console.log();

  // ─── Step 2: Deploy Factory & Group Implementation ──────────────────
  console.log("🏗️  Deploying TakturnsGroup implementation...");
  const GroupImpl = await ethers.getContractFactory("TakturnsGroup");
  const groupImpl = await GroupImpl.deploy();
  console.log(`   Implementation: ${await groupImpl.getAddress()}`);

  console.log("🏗️  Deploying TakturnsFactory...");
  const Factory = await ethers.getContractFactory("TakturnsFactory");
  const factory = await Factory.deploy(await groupImpl.getAddress());
  console.log(`   Factory:        ${await factory.getAddress()}`);
  console.log();

  // ─── Step 3: Create a Grade 1 Group ─────────────────────────────────
  console.log("📋 Creating Grade 1 group (10 USDC/cycle, 3 members, 60s cycles)...");
  const tx = await factory.createGroup(1, CONTRIBUTION, CYCLE_DURATION, 3, usdcAddress);
  const receipt = await tx.wait();

  const event = receipt?.logs.find((log) => {
    try {
      return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "GroupCreated";
    } catch { return false; }
  });
  const parsed = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
  const groupAddress = parsed!.args[0];
  const group = GroupImpl.attach(groupAddress);
  console.log(`   Group deployed: ${groupAddress}`);
  console.log();

  // ─── Step 4: Members Join ───────────────────────────────────────────
  const usdc = await ethers.getContractAt("IERC20", usdcAddress);

  console.log("🤝 Members joining the group...");
  for (const signer of [deployer, alice, bob]) {
    await usdc.connect(signer).approve(groupAddress, COLLATERAL);
    await group.connect(signer).joinGroup();
    console.log(`   ✅ ${signer.address} joined (deposited ${COLLATERAL / USDC_DECIMALS} USDC collateral)`);
  }
  console.log();

  // Pre-approve contributions for all cycles
  const bigApproval = CONTRIBUTION * 10n;
  for (const signer of [deployer, alice, bob]) {
    await usdc.connect(signer).approve(groupAddress, bigApproval);
  }

  // ─── Step 5: Admin Starts the Group ─────────────────────────────────
  console.log("🚀 Admin starting the group...");
  await group.connect(deployer).startGroup();
  const order = await group.getCollectionOrder();
  console.log(`   Collection order: ${order.map((a: string) => a.slice(0, 8) + "...").join(" → ")}`);
  console.log();

  // ─── Step 6: Cycle 1 — All Contribute ──────────────────────────────
  console.log("💰 Cycle 1: All members contribute...");
  for (const signer of [deployer, alice, bob]) {
    await group.connect(signer).contribute();
    console.log(`   ✅ ${signer.address.slice(0, 8)}... contributed ${CONTRIBUTION / USDC_DECIMALS} USDC`);
  }
  const recipient1 = order[0];
  console.log(`   🎯 Auto-distributed ${CONTRIBUTION * 3n / USDC_DECIMALS} USDC → ${recipient1.slice(0, 8)}...`);
  console.log();

  // ─── Step 7: Cycle 2 — All Contribute ──────────────────────────────
  console.log("💰 Cycle 2: All members contribute...");
  for (const signer of [deployer, alice, bob]) {
    await group.connect(signer).contribute();
    console.log(`   ✅ ${signer.address.slice(0, 8)}... contributed ${CONTRIBUTION / USDC_DECIMALS} USDC`);
  }
  const recipient2 = order[1];
  console.log(`   🎯 Auto-distributed ${CONTRIBUTION * 3n / USDC_DECIMALS} USDC → ${recipient2.slice(0, 8)}...`);
  console.log();

  // ─── Step 8: Cycle 3 — Bob Defaults ─────────────────────────────────
  console.log("⚠️  Cycle 3: Bob defaults!");
  await group.connect(deployer).contribute();
  await group.connect(alice).contribute();
  console.log(`   ✅ Deployer contributed`);
  console.log(`   ✅ Alice contributed`);
  console.log(`   ❌ Bob did NOT contribute`);

  // Fast-forward past the deadline (only works on local)
  if (isLocal) {
    console.log(`   ⏩ Fast-forwarding ${CYCLE_DURATION + 1} seconds past the deadline...`);
    await ethers.provider.send("evm_increaseTime", [CYCLE_DURATION + 1]);
    await ethers.provider.send("evm_mine", []);
  } else {
    console.log(`   ⏳ Waiting for deadline (${CYCLE_DURATION}s on testnet)...`);
    console.log("   ⚠️  On testnet you would need to wait for the actual deadline.");
    console.log("   ⚠️  For demo purposes, set CYCLE_DURATION to a short value (e.g., 60s).");
    // Wait for the cycle duration to pass
    await new Promise((resolve) => setTimeout(resolve, (CYCLE_DURATION + 5) * 1000));
  }

  console.log();
  console.log("🚨 Flagging Bob as a defaulter...");
  await group.connect(deployer).flagDefaulter(bob.address);
  console.log(`   ✅ Bob flagged — collateral seized and distributed`);
  console.log(`   ✅ Bob blacklisted in the factory`);
  console.log();

  // ─── Step 9: Vote to Continue ───────────────────────────────────────
  console.log("🗳️  Voting: Continue or Dissolve?");
  await group.connect(deployer).vote(1); // Continue
  await group.connect(alice).vote(1);     // Continue
  console.log(`   ✅ Deployer voted: Continue`);
  console.log(`   ✅ Alice voted: Continue`);

  console.log("📊 Resolving vote...");
  await group.resolveVote();
  console.log(`   ✅ Vote resolved: Continue (supermajority reached)`);
  console.log();

  // ─── Step 10: Final Report ──────────────────────────────────────────
  const groupState = await group.state();
  const stateNames = ["Pending", "Active", "Completed", "Dissolved"];

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                     FINAL REPORT                           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`Group State: ${stateNames[Number(groupState)]}`);
  console.log(`Current Cycle: ${await group.currentCycle()}`);
  console.log();

  console.log("Member Profiles (Factory):");
  console.log("─────────────────────────────────────────────────────────────");
  for (const [label, signer] of [["Deployer", deployer], ["Alice", alice], ["Bob", bob]] as const) {
    const profile = await factory.getMemberProfile(signer.address);
    const balance = await usdc.balanceOf(signer.address);
    console.log(`  ${label} (${signer.address.slice(0, 10)}...):`);
    console.log(`    Grade: ${profile.grade}  |  Consecutive: ${profile.consecutiveCompletions}  |  Blacklisted: ${profile.isBlacklisted}  |  USDC: ${balance / USDC_DECIMALS}`);
  }
  console.log();

  const groupBalance = await usdc.balanceOf(groupAddress);
  console.log(`Group Contract Balance: ${groupBalance / USDC_DECIMALS} USDC`);
  console.log();
  console.log("✨ Demo complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
