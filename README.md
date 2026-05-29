# Takturns — Onchain Ajo (Rotating Savings)

Takturns is a decentralized, non-custodial rotating savings and credit association (ROSCA) protocol—commonly known as an "Ajo" or "Esusu"—built on Arbitrum. It allows groups of users to pool funds together on a regular cycle and take turns receiving the lump sum payout, with strict algorithmic enforcement of contributions, collateralization, and reputation tracking.

## Architecture

The protocol uses a **Factory-Clone** architecture to ensure gas-efficient creation of new savings groups. 

- **`TakturnsFactory.sol`**: The central factory that deploys minimal proxy clones of the group logic. It also serves as the global reputation ledger, tracking member "grades", consecutive successful cycles, and blacklisting defaulters across the entire protocol.
- **`TakturnsGroup.sol`**: The core logic implementation for an individual savings group. Handles joining, collateral deposits, cycle contributions, automated fund distribution, voting (Continue vs. Dissolve), and defaulting mechanisms.

### Key Features
1. **Automated Distributions**: Once all active members contribute for a cycle, the pooled USDC is instantly and automatically transferred to the scheduled recipient.
2. **Reputation Grades**: Users start at Grade 1 and must complete successful cycles to be promoted to higher grades, unlocking larger pools and lower collateral requirements.
3. **Collateral & Slashing**: Members must deposit an upfront collateral based on their grade. If a member fails to contribute by the cycle deadline, any other member can "flag" them. The defaulter's collateral is seized and distributed to the pool, and they are permanently blacklisted.
4. **Decentralized Governance**: If a default occurs, remaining members vote on whether to continue the cycle without the defaulter or dissolve the group entirely (requires >66% supermajority).

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v22 recommended)
- npm or yarn

### Installation

Clone the repository and install dependencies:
```bash
git clone https://github.com/crystalz05/takturns-contract.git
cd takturns-smart-contract
npm install
```

### Environment Setup

Copy the example environment file and configure it:
```bash
cp .env.example .env
```
Fill in the `.env` file with your deployer private key and an Arbiscan API key for contract verification.

---

## Development & Testing

### Compile Contracts
```bash
npm run compile
```

### Run Tests
The test suite covers edge cases, math precision, and full group lifecycles.
```bash
npm run test
```

To view test coverage:
```bash
npm run coverage
```

---

## Local Demo

You can run an end-to-end simulated lifecycle of a Takturns group (including a simulated user defaulting and getting slashed) on a local Hardhat node. This automatically spins up fake wallets and a Mock USDC token.

```bash
npm run demo
```

---

## Testnet Deployment (Arbitrum Sepolia)

### 1. Testnet Setup & Funding
Before deploying, you need Arbitrum Sepolia ETH (for gas) and Circle Testnet USDC (for the protocol). Run the setup script for instructions and direct faucet links:
```bash
npm run setup:testnet
```

### 2. Deploy Contracts
Deploy the `TakturnsFactory` and `TakturnsGroup` implementation to the testnet using Hardhat Ignition:
```bash
npm run deploy:sepolia
```

### 3. Verify Contracts
Once deployed, verify the contracts on Arbiscan so they can be interacted with directly from the block explorer:
```bash
npx hardhat verify --network arbitrumSepolia <FACTORY_ADDRESS> <GROUP_IMPLEMENTATION_ADDRESS>
npx hardhat verify --network arbitrumSepolia <GROUP_IMPLEMENTATION_ADDRESS>
```

---

## Frontend Integration

The compiled Application Binary Interfaces (ABIs) and Typechain definitions are automatically generated upon compilation. 
- **ABIs**: `artifacts/contracts/`
- **TypeScript Types**: `typechain-types/`

Your frontend (e.g., Flutter or React) can interact with the deployed `TakturnsFactory` contract to create new groups and query user reputation. When a group is created, the factory emits a `GroupCreated` event containing the address of the newly deployed minimal proxy group.

## License
MIT
