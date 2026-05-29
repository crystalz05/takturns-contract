import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Hardhat Ignition module for deploying the Takturns protocol.
 *
 * Deploys:
 *   1. TakturnsGroup (implementation contract — used as a template for clones)
 *   2. TakturnsFactory (factory contract — deploys group proxies via Clones)
 *
 * The factory constructor initializes the 4 grade tiers automatically.
 * After deployment, anyone can call factory.createGroup() to spin up
 * a new rotating-savings group.
 */
const TakturnsModule = buildModule("TakturnsModule", (m) => {
  // 1. Deploy the TakturnsGroup implementation (template for clones)
  const groupImplementation = m.contract("TakturnsGroup");

  // 2. Deploy the TakturnsFactory with the implementation address
  const factory = m.contract("TakturnsFactory", [groupImplementation]);

  return { groupImplementation, factory };
});

export default TakturnsModule;
