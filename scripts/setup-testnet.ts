/**
 * Setup Testnet Utility
 *
 * Prints instructions for getting testnet tokens needed to
 * deploy and demo the Takturns protocol on Arbitrum Sepolia.
 *
 * Usage:
 *   npx hardhat run scripts/setup-testnet.ts
 */

import { ethers } from "hardhat";

const CIRCLE_USDC_ARBITRUM_SEPOLIA = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║           TAKTURNS — Testnet Setup Instructions             ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`Your deployer wallet: ${deployer.address}`);
  console.log();

  // Check ETH balance
  const ethBalance = await ethers.provider.getBalance(deployer.address);
  const ethFormatted = ethers.formatEther(ethBalance);
  console.log(`Current ETH balance: ${ethFormatted} ETH`);

  if (ethBalance === 0n) {
    console.log("⚠️  You need ETH for gas fees!");
  } else {
    console.log("✅ ETH balance looks good.");
  }
  console.log();

  // Check USDC balance
  try {
    const usdc = await ethers.getContractAt("IERC20", CIRCLE_USDC_ARBITRUM_SEPOLIA);
    const usdcBalance = await usdc.balanceOf(deployer.address);
    console.log(`Current USDC balance: ${usdcBalance / 1_000_000n} USDC`);

    if (usdcBalance === 0n) {
      console.log("⚠️  You need USDC for collateral and contributions!");
    } else {
      console.log("✅ USDC balance looks good.");
    }
  } catch {
    console.log("⚠️  Could not check USDC balance (are you on the right network?)");
  }

  console.log();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();
  console.log("Step 1: Get Arbitrum Sepolia ETH (gas fees)");
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  Option A — Arbitrum Faucet:");
  console.log("    https://faucet.arbitrum.io/");
  console.log("    → Connect wallet, select 'Arbitrum Sepolia', claim ETH");
  console.log();
  console.log("  Option B — Alchemy Faucet:");
  console.log("    https://www.alchemy.com/faucets/arbitrum-sepolia");
  console.log("    → Enter your wallet address, claim 0.1 ETH");
  console.log();
  console.log("  Option C — Bridge from Sepolia L1:");
  console.log("    https://bridge.arbitrum.io/");
  console.log("    → Bridge Sepolia ETH to Arbitrum Sepolia");
  console.log();

  console.log("Step 2: Get Testnet USDC (for collateral & contributions)");
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  Circle Faucet:");
  console.log("    https://faucet.circle.com/");
  console.log("    → Select 'Arbitrum Sepolia'");
  console.log("    → Enter your wallet address");
  console.log("    → Claim testnet USDC");
  console.log();
  console.log(`  USDC Contract: ${CIRCLE_USDC_ARBITRUM_SEPOLIA}`);
  console.log();

  console.log("Step 3: Deploy the Protocol");
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  npx hardhat ignition deploy ignition/modules/deploy.ts --network arbitrumSepolia");
  console.log();

  console.log("Step 4: Verify on Arbiscan (optional)");
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  npx hardhat verify --network arbitrumSepolia <FACTORY_ADDRESS> <IMPL_ADDRESS>");
  console.log("  npx hardhat verify --network arbitrumSepolia <IMPL_ADDRESS>");
  console.log();

  console.log("Step 5: Run the Demo");
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  npx hardhat run scripts/demo-cycle.ts --network arbitrumSepolia");
  console.log();
  console.log("✨ You're all set!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
