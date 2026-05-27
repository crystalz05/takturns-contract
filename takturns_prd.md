# Takturns — Product Requirements Document
**Onchain Rotating Savings for Nigerians on Arbitrum**
Version 1.0 | Arbitrum Open House Buildathon | May 2026

---

## 1. Overview

### 1.1 Problem Statement
Ajo (also called Esusu or Susu) is a centuries-old Nigerian rotating savings practice where a group of trusted people contribute a fixed amount regularly, and each member takes turns collecting the entire pool. It works on social trust — but that trust breaks constantly. Members disappear with funds, skip contributions, or manipulate rotation order. There is no enforcement mechanism, no transparency, and no recourse.

### 1.2 Solution
Takturns is a mobile-first Flutter application built on Arbitrum that puts the Ajo savings model onchain. Smart contracts replace social trust — contributions are enforced, rotation is automatic and transparent, and no single person controls the funds. The contract is the treasurer.

### 1.3 Target Users
- Nigerian individuals who already participate in informal Ajo groups
- Diaspora Nigerians who want to run savings groups with family/friends back home
- Small groups (5–20 people) who trust each other socially but want financial enforcement

### 1.4 Buildathon Track
Core Trustless Work Applications — trustless coordination and payments primitive

---

## 2. Goals

### 2.1 Primary Goals
- Deploy a working Ajo smart contract on Arbitrum Sepolia testnet
- Build a functional Flutter mobile app that interacts with the contract
- Demonstrate a complete cycle: group creation → contributions → distribution → next rotation

### 2.2 Secondary Goals
- Tell a compelling cultural story that differentiates from generic DeFi projects
- Show a working demo with real wallet transactions on testnet

### 2.3 Out of Scope (for buildathon)
- Mainnet deployment
- KYC/identity verification
- Fiat on/off ramp
- Push notifications
- Multi-language support

---

## 3. User Stories

### Group Admin
- As an admin, I want to create an Ajo group with a fixed contribution amount, cycle frequency, and maximum member count
- As an admin, I want to set the rotation order for who collects each cycle
- As an admin, I want to see the full status of the group at any time

### Group Member
- As a member, I want to join an existing Ajo group using an invite code
- As a member, I want to contribute my USDC for the current cycle
- As a member, I want to see who has contributed and who hasn't
- As a member, I want to know when it's my turn to collect
- As a member, I want to see the full transaction history of the group

### Both
- As a user, I want to connect my MetaMask wallet to the app
- As a user, I want to see my wallet balance before contributing

---

## 4. Smart Contract Specification

### 4.1 Contract: TakturnsGroup.sol

**State Variables**
```
address public admin
address[] public members
uint256 public contributionAmount     // in USDC (6 decimals)
uint256 public cycleDurationDays
uint256 public currentCycle
uint256 public currentRecipientIndex
uint256 public cycleStartTime
mapping(address => bool) public hasContributedThisCycle
mapping(address => uint256) public totalContributed
bool public isActive
```

**Core Functions**

| Function | Parameters | Description |
|---|---|---|
| `createGroup()` | amount, duration, maxMembers | Admin deploys and configures group |
| `joinGroup()` | — | Member joins, wallet registered |
| `contribute()` | — | Member deposits USDC for current cycle |
| `distributeFunds()` | — | Sends pool to current cycle recipient, advances rotation |
| `getGroupStatus()` | — | Returns full group state (view) |
| `getMemberStatus()` | address | Returns member contribution status (view) |
| `leaveGroup()` | — | Member exits before their turn (penalty applies) |

**Events**
```
GroupCreated(address admin, uint256 amount, uint256 duration)
MemberJoined(address member)
ContributionMade(address member, uint256 cycle)
FundsDistributed(address recipient, uint256 amount, uint256 cycle)
MemberLeft(address member)
```

**Rules enforced by contract**
- Member cannot contribute twice in one cycle
- Distribution only triggers when all members have contributed
- Rotation order is fixed at group creation, cannot be changed
- Admin cannot manipulate who receives funds

### 4.2 Token
USDC on Arbitrum Sepolia testnet (mock ERC-20 for demo purposes)

### 4.3 Deployment
Network: Arbitrum Sepolia testnet
Tool: Hardhat

---

## 5. Flutter App Specification

### 5.1 Tech Stack
- Flutter (Dart)
- web3dart — blockchain interaction
- http — RPC calls to Arbitrum node
- BLoC — state management
- GoRouter — navigation
- get_it — dependency injection

### 5.2 Screens

**Screen 1: Wallet Connect**
- Connect MetaMask wallet button
- Display connected wallet address (truncated)
- Display USDC balance
- Proceed button

**Screen 2: Home Dashboard**
- Create New Group button
- Join Existing Group button
- List of groups user belongs to
- Each group card shows: name, current cycle, next collection date

**Screen 3: Create Group**
- Group name input
- Contribution amount input (USDC)
- Cycle duration selector (weekly / biweekly / monthly)
- Max members input
- Deploy Contract button
- Loading state while transaction confirms

**Screen 4: Join Group**
- Contract address input field (or QR scan)
- Group details preview before joining
- Confirm Join button

**Screen 5: Group Detail**
- Group name and cycle counter
- Progress bar: X of N members have contributed this cycle
- Member list with contribution status (green tick / grey pending)
- Current recipient highlighted
- Your status: Contributed / Not Yet
- Contribute button (disabled if already contributed)
- Transaction history list

**Screen 6: Contribute**
- Summary: amount, cycle number, recipient this cycle
- Confirm & Pay button
- Loading state while transaction confirms
- Success confirmation with transaction hash

### 5.3 Navigation Flow
```
WalletConnect → Home → CreateGroup
                    → JoinGroup → GroupDetail → Contribute
                    → GroupDetail (existing)
```

---

## 6. User Flow: Complete Cycle

```
1. Admin opens app, connects wallet
2. Admin creates group: 10 USDC/week, 5 members
3. Smart contract deployed, admin gets invite address
4. 4 members join using contract address
5. Week 1 begins: all 5 members contribute 10 USDC each
6. Contract holds 50 USDC
7. All contributions received → distributeFunds() called
8. Member 1 (first in rotation) receives 50 USDC
9. Cycle counter increments to Week 2
10. Process repeats until all 5 members have collected
```

---

## 7. Technical Architecture

```
Flutter App
    │
    ├── web3dart package
    │       │
    │       └── Arbitrum Sepolia RPC (Alchemy/Infura)
    │               │
    │               └── TakturnsGroup.sol (Smart Contract)
    │                       │
    │                       └── Mock USDC ERC-20
    │
    └── MetaMask (wallet signing)
```

---

## 8. Development Phases

### Phase 1: Smart Contract (Days 1–4)
- Write TakturnsGroup.sol
- Write Hardhat deployment scripts
- Deploy to Arbitrum Sepolia testnet
- Write basic interaction scripts to test all functions
- Generate ABI for Flutter integration

### Phase 2: Flutter Foundation (Days 5–8)
- Project setup: BLoC, GoRouter, get_it, web3dart
- Wallet connection screen
- Contract service layer (reads group state from chain)
- Home dashboard with mock data

### Phase 3: Core Flows (Days 9–14)
- Create group flow (deploys contract)
- Join group flow
- Group detail screen with live chain data
- Contribute flow with transaction signing

### Phase 4: Polish & Demo (Days 15–21)
- Fix all broken flows
- Error states and loading states
- Record demo video
- Write project submission

---

## 9. Demo Script (for judges)

1. Show the problem: "This is how Ajo works in Nigeria. The problem is trust."
2. Open app, connect wallet
3. Create a group live: 10 USDC, weekly, 3 members
4. Switch to second wallet, join group
5. Switch to third wallet, join group
6. All three wallets contribute
7. Show contract auto-distributing to first member
8. Show transaction on Arbitrum Sepolia explorer
9. "The contract is the treasurer. Nobody can run."

Total demo time: 3–4 minutes

---

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| web3dart integration complexity | High | Start integration early in Phase 2, not Phase 3 |
| MetaMask mobile deep linking issues | Medium | Use WalletConnect as fallback |
| USDC testnet availability | Low | Deploy mock ERC-20 if needed |
| Contract bugs causing locked funds | Medium | Test every function with Hardhat scripts before Flutter |
| Running out of time | High | Cut UI polish, keep core flow working |

---

## 11. Success Criteria

**Minimum (must have for submission)**
- Smart contract deployed on Arbitrum Sepolia
- Flutter app connects to wallet
- At least one complete Ajo cycle demonstrated in demo video

**Target**
- All 6 screens functional
- Live group creation and contribution in demo
- Clean UI with Nigerian cultural references

**Stretch**
- Dispute mechanism if contribution missed
- Penalty/exit logic for early leavers
- QR code for group invite

---

## 12. Submission Checklist

- Smart contract source code on GitHub
- Flutter app source code on GitHub
- Deployed contract address on Arbitrum Sepolia
- 3–4 minute demo video
- Project description (500 words max)
- Team info

---

*Takturns — Take turns saving. No trust required.*
