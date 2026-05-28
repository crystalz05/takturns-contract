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

    // --- Events ---

    event MemberJoined(address indexed member, uint256 collateralAmount, uint8 memberGrade);
    event GroupStarted(uint256 cycleStartTime, bool isMixedGrade, uint256 memberCount);
    event ContributionMade(address indexed member, uint256 indexed cycle, uint256 amount);
    event FundsDistributed(address indexed recipient, uint256 indexed cycle, uint256 totalAmount);
    event CycleAdvanced(uint256 indexed newCycle, address indexed nextRecipient);
    event GroupCompleted(uint256 totalCycles);
    event CollateralRefunded(address indexed member, uint256 amount);

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

    /**
     * @notice Join the group. Requires grade >= minGrade, not blacklisted,
     *         and transfers collateral from the caller.
     */
    function joinGroup() external;

    /**
     * @notice Admin-only. Transitions from Pending → Active. Determines collection
     *         order and starts Cycle 1.
     */
    function startGroup() external;

    // --- Phase 3: Contributions & Distribution ---

    /**
     * @notice Contribute the fixed amount for the current cycle.
     *         When all members have contributed, auto-distributes to the current recipient.
     */
    function contribute() external;

    // --- View Functions ---
    
    function state() external view returns (GroupState);
    function currentCycle() external view returns (uint256);
    function getCurrentRecipient() external view returns (address);
    function getCollectionOrder() external view returns (address[] memory);
    function getMembers() external view returns (address[] memory);
    function getCycleProgress() external view returns (uint256 contributed, uint256 total);
}
