// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title ITakturnsFactory
 * @notice Factory for deploying Takturns groups and managing the global reputation system.
 */
interface ITakturnsFactory {
    // --- Structs ---

    struct GradeRules {
        uint256 minContribution;
        uint256 maxContribution;
        uint256 collateralPercent; // e.g. 150 for 150%
    }

    struct MemberProfile {
        uint8 grade;                   // 1 to 4
        uint256 consecutiveCompletions; // Reset to 0 on default
        bool isBlacklisted;            // Permanently banned if true
    }

    // --- Events ---

    event GroupCreated(address indexed groupAddress, address indexed creator, uint8 minGrade, address token);
    event MemberPromoted(address indexed member, uint8 newGrade);
    event MemberBlacklisted(address indexed member, address indexed group);
    event ConsecutiveCompletionRecorded(address indexed member, uint256 currentCount);

    // --- View Functions ---

    /**
     * @notice Returns the rules for a specific grade level.
     * @param _grade The grade level (1-4).
     */
    function getGradeRules(uint8 _grade) external view returns (GradeRules memory);

    /**
     * @notice Returns the global reputation profile of a user.
     * @param _user The user's address.
     */
    function getMemberProfile(address _user) external view returns (MemberProfile memory);

    /**
     * @notice Calculates the collateral amount required for a contribution amount.
     * @param _contribution The contribution amount per cycle.
     * @param _minGrade The grade tier the group belongs to.
     * @return The required collateral amount.
     */
    function getCollateralAmount(uint256 _contribution, uint8 _minGrade) external view returns (uint256);

    // --- State-Modifying Functions ---

    /**
     * @notice Deploys a new Takturns group.
     * @param _minGrade Minimum grade required to join.
     * @param _contribution Amount each member contributes per cycle.
     * @param _cycleDuration Duration of a cycle in seconds.
     * @param _maxMembers Maximum number of members.
     * @param _token Address of the ERC20 token used (e.g. USDC).
     * @return groupAddress The address of the newly deployed group.
     */
    function createGroup(
        uint8 _minGrade,
        uint256 _contribution,
        uint256 _cycleDuration,
        uint256 _maxMembers,
        address _token
    ) external returns (address groupAddress);

    /**
     * @notice Called by a group to report that a user successfully completed a cycle.
     *         Updates their consecutive completions and promotes them if threshold is met.
     * @param _user The user's address.
     */
    function recordSuccessfulCycle(address _user) external;

    /**
     * @notice Called by a group to report a user who defaulted.
     *         Blacklists the user immediately.
     * @param _user The user's address.
     */
    function reportDefault(address _user) external;
}
