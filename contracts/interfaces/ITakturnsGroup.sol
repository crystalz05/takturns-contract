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
        Pending,   // Accepting members
        Active,    // Cycle is running
        Completed  // All cycles finished
    }

    // --- Structs ---

    struct MemberInfo {
        bool hasJoined;
        bool hasCollected; // True if they received the payout for their turn
        bool hasDefaulted; // True if they missed a payment or were kicked
        bool isLeaving;    // True if they requested to leave gracefully
        uint256 cycleJoined; // Cycle number when they joined
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

    // --- View Functions ---
    
    function state() external view returns (GroupState);
    function currentCycle() external view returns (uint256);
}
