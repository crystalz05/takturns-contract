// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./ITakturnsFactory.sol";

/**
 * @title ITakturnsGroup
 * @notice Interface for a Takturns rotating savings group.
 */
interface ITakturnsGroup {
    // --- Enums ---

    enum GroupState {
        Pending,    // Accepting members
        Active,     // Cycles are running
        Completed,  // All cycles finished successfully
        Dissolved   // Dissolved via vote after a default
    }

    enum VoteOption {
        None,
        Continue,
        Dissolve
    }

    // --- Structs ---

    struct MemberInfo {
        bool hasJoined;
        bool hasCollected;     // True if they received the payout for their turn
        bool hasDefaulted;     // True if they missed a payment or were kicked
        bool isLeaving;        // True if they requested to leave gracefully
        uint256 collateralDeposited;
    }

    struct GroupConfig {
        address admin;
        address factory;
        address token;
        uint8 minGrade;
        uint256 contributionAmount;
        uint256 cycleDuration;
        uint256 maxMembers;
    }

    // --- Events (Phase 2 & 3) ---

    event MemberJoined(address indexed member, uint256 collateralAmount, uint8 memberGrade);
    event GroupStarted(uint256 cycleStartTime, bool isMixedGrade, uint256 memberCount);
    event ContributionMade(address indexed member, uint256 indexed cycle, uint256 amount);
    event FundsDistributed(address indexed recipient, uint256 indexed cycle, uint256 totalAmount);
    event CycleAdvanced(uint256 indexed newCycle, address indexed nextRecipient);
    event GroupCompleted(uint256 totalCycles);
    event CollateralRefunded(address indexed member, uint256 amount);

    // --- Events (Phase 4) ---

    event MemberDefaulted(address indexed member, uint256 indexed cycle, uint256 collateralSeized);
    event VotingOpened(uint256 indexed cycle, uint256 activeVoterCount);
    event VoteCast(address indexed member, VoteOption option);
    event VoteResolved(VoteOption outcome);
    event GroupDissolved(uint256 indexed cycle);
    event MemberLeft(address indexed member, uint256 collateralReturned);
    event EmergencyRefund(address indexed admin, uint256 indexed cycle);

    // --- Initialization ---

    /**
     * @notice Initializes the group. Should only be called once by the factory.
     */
    function initialize(
        address _admin,
        address _factory,
        address _token,
        uint8 _minGrade,
        uint256 _contributionAmount,
        uint256 _cycleDuration,
        uint256 _maxMembers
    ) external;

    // --- Phase 2: Joining & Starting ---

    function joinGroup() external;
    function startGroup() external;

    // --- Phase 3: Contributions & Distribution ---

    function contribute() external;

    // --- Phase 4: Default Resolution, Voting & Leave ---

    /**
     * @notice Flag a member who has not contributed by the deadline.
     *         Seizes their collateral, distributes it among active members,
     *         blacklists them in the factory, and opens voting.
     * @param _member The address of the defaulting member.
     */
    function flagDefaulter(address _member) external;

    /**
     * @notice Cast a vote to Continue or Dissolve the group after a default.
     *         Only active (non-defaulted) members may vote.
     * @param _option The vote: Continue or Dissolve.
     */
    function vote(VoteOption _option) external;

    /**
     * @notice Resolve the vote when supermajority (>66%) is reached.
     *         Executes the winning outcome (continue or dissolve).
     */
    function resolveVote() external;

    /**
     * @notice Leave the group voluntarily.
     *         - During Pending: full collateral refund.
     *         - During Active: collateral returned, current cycle contribution forfeited.
     *         - Reverts if the member has already received a payout.
     */
    function leaveGroup() external;

    /**
     * @notice Admin-only emergency circuit breaker. Returns all held funds
     *         proportionally to active members.
     */
    function emergencyRefund() external;

    // --- View Functions ---
    
    function state() external view returns (GroupState);
    function currentCycle() external view returns (uint256);
    function getCurrentRecipient() external view returns (address);
    function getCollectionOrder() external view returns (address[] memory);
    function getMembers() external view returns (address[] memory);
    function getCycleProgress() external view returns (uint256 contributed, uint256 total);
}
