// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./interfaces/ITakturnsGroup.sol";
import "./interfaces/ITakturnsFactory.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title TakturnsGroup
 * @notice Implementation of a Takturns rotating savings group.
 */
contract TakturnsGroup is ITakturnsGroup, Initializable {
    // --- State Variables ---

    GroupConfig public config;
    GroupState public override state;
    uint256 public override currentCycle;

    // Mapping of member address to their info
    mapping(address => MemberInfo) public members;
    // Array of member addresses to preserve order/turn
    address[] public memberAddresses;

    // --- Modifiers ---

    modifier onlyAdmin() {
        require(msg.sender == config.admin, "TakturnsGroup: Caller is not admin");
        _;
    }

    modifier onlyState(GroupState _requiredState) {
        require(state == _requiredState, "TakturnsGroup: Invalid state");
        _;
    }

    // --- Initialization ---

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _admin,
        address _factory,
        address _token,
        uint8 _minGrade,
        uint256 _contributionAmount,
        uint256 _cycleDuration,
        uint256 _maxMembers
    ) external override initializer {
        require(_admin != address(0), "Invalid admin");
        require(_factory != address(0), "Invalid factory");
        require(_token != address(0), "Invalid token");

        config = GroupConfig({
            admin: _admin,
            factory: _factory,
            token: _token,
            minGrade: _minGrade,
            contributionAmount: _contributionAmount,
            cycleDuration: _cycleDuration,
            maxMembers: _maxMembers
        });

        state = GroupState.Pending;
        currentCycle = 0;
    }

    // --- Core Architecture Placeholders (To be implemented in Phase 3 & 4) ---

    // function joinGroup() external { ... }
    // function startGroup() external onlyAdmin { ... }
    // function payContribution() external { ... }
    // function claimPayout() external { ... }
    // function reportDefault(address _member) external { ... }
    // function requestLeave() external { ... }
}
