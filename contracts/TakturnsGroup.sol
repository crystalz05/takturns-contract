// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./interfaces/ITakturnsGroup.sol";
import "./interfaces/ITakturnsFactory.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title TakturnsGroup
 * @notice Implementation of a Takturns rotating savings group.
 *         Handles joining, collateral, contributions, auto-distribution,
 *         and collection priority.
 */
contract TakturnsGroup is ITakturnsGroup, Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State Variables ────────────────────────────────────────────────

    GroupConfig public config;
    GroupState public override state;
    uint256 public override currentCycle;

    // Members
    mapping(address => MemberInfo) public members;
    address[] public memberAddresses;

    // Cycle & Distribution
    uint256 public cycleStartTime;
    uint256 public currentRecipientIndex;
    address[] public collectionOrder;
    uint256 public contributionsThisCycle;
    bool public isMixedGrade;

    // Per-cycle contribution tracking
    mapping(uint256 => mapping(address => bool)) public hasContributedThisCycle;

    // Payout tracking
    mapping(address => bool) public hasReceivedPayout;

    // ─── Modifiers ──────────────────────────────────────────────────────

    modifier onlyAdmin() {
        require(msg.sender == config.admin, "TakturnsGroup: Caller is not admin");
        _;
    }

    modifier onlyState(GroupState _requiredState) {
        require(state == _requiredState, "TakturnsGroup: Invalid state");
        _;
    }

    modifier onlyMember() {
        require(members[msg.sender].hasJoined, "TakturnsGroup: Not a member");
        _;
    }

    // ─── Initialization ─────────────────────────────────────────────────

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
        require(_maxMembers > 1, "Max members must be > 1");
        require(_cycleDuration > 0, "Cycle duration must be > 0");

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

    // ─── Phase 2: Joining & Starting ────────────────────────────────────

    /**
     * @notice Join the group during the Pending phase.
     *         Checks eligibility via the factory, then transfers collateral.
     */
    function joinGroup() external override onlyState(GroupState.Pending) nonReentrant {
        require(!members[msg.sender].hasJoined, "TakturnsGroup: Already a member");
        require(memberAddresses.length < config.maxMembers, "TakturnsGroup: Group is full");

        // Check eligibility via factory
        ITakturnsFactory factory = ITakturnsFactory(config.factory);
        ITakturnsFactory.MemberProfile memory profile = factory.getMemberProfile(msg.sender);
        require(!profile.isBlacklisted, "TakturnsGroup: Blacklisted");
        require(profile.grade >= config.minGrade, "TakturnsGroup: Grade too low");

        // Calculate collateral
        uint256 collateralAmount = factory.getCollateralAmount(
            config.contributionAmount,
            config.minGrade
        );

        // Transfer collateral from the user
        IERC20(config.token).safeTransferFrom(msg.sender, address(this), collateralAmount);

        // Register the member
        members[msg.sender] = MemberInfo({
            hasJoined: true,
            hasCollected: false,
            hasDefaulted: false,
            isLeaving: false,
            collateralDeposited: collateralAmount
        });
        memberAddresses.push(msg.sender);

        emit MemberJoined(msg.sender, collateralAmount, profile.grade);
    }

    /**
     * @notice Admin starts the group. Transitions Pending → Active.
     *         Determines collection order and starts Cycle 1.
     */
    function startGroup() external override onlyAdmin onlyState(GroupState.Pending) {
        require(memberAddresses.length >= 2, "TakturnsGroup: Need at least 2 members");

        // Determine if mixed-grade
        isMixedGrade = _checkMixedGrade();

        // Build collection order
        _buildCollectionOrder();

        // Transition to Active
        state = GroupState.Active;
        currentCycle = 1;
        cycleStartTime = block.timestamp;
        currentRecipientIndex = 0;
        contributionsThisCycle = 0;

        emit GroupStarted(block.timestamp, isMixedGrade, memberAddresses.length);
    }

    // ─── Phase 3: Contributions & Auto-Distribution ─────────────────────

    /**
     * @notice Contribute the fixed amount for the current cycle.
     *         When all active members have contributed, auto-distributes to the recipient.
     */
    function contribute() external override onlyState(GroupState.Active) onlyMember nonReentrant {
        require(!members[msg.sender].hasDefaulted, "TakturnsGroup: Defaulted members cannot contribute");
        require(
            !hasContributedThisCycle[currentCycle][msg.sender],
            "TakturnsGroup: Already contributed this cycle"
        );

        // Transfer contribution from sender
        IERC20(config.token).safeTransferFrom(
            msg.sender,
            address(this),
            config.contributionAmount
        );

        // Mark as contributed
        hasContributedThisCycle[currentCycle][msg.sender] = true;
        contributionsThisCycle += 1;

        emit ContributionMade(msg.sender, currentCycle, config.contributionAmount);

        // Check if all active members have contributed → auto-distribute
        uint256 activeMemberCount = _getActiveMemberCount();
        if (contributionsThisCycle == activeMemberCount) {
            _distributeFunds();
        }
    }

    // ─── View Functions ─────────────────────────────────────────────────

    function getCurrentRecipient() external view override returns (address) {
        require(state == GroupState.Active, "TakturnsGroup: Not active");
        return collectionOrder[currentRecipientIndex];
    }

    function getCollectionOrder() external view override returns (address[] memory) {
        return collectionOrder;
    }

    function getMembers() external view override returns (address[] memory) {
        return memberAddresses;
    }

    function getCycleProgress() external view override returns (uint256 contributed, uint256 total) {
        contributed = contributionsThisCycle;
        total = _getActiveMemberCount();
    }

    /**
     * @notice Returns the collateral amount required to join this group.
     */
    function getRequiredCollateral() external view returns (uint256) {
        return ITakturnsFactory(config.factory).getCollateralAmount(
            config.contributionAmount,
            config.minGrade
        );
    }

    // ─── Internal Functions ─────────────────────────────────────────────

    /**
     * @dev Distributes the pooled contributions to the current recipient.
     *      Called automatically when all active members have contributed.
     */
    function _distributeFunds() internal {
        address recipient = collectionOrder[currentRecipientIndex];
        uint256 activeMemberCount = _getActiveMemberCount();
        uint256 totalPool = config.contributionAmount * activeMemberCount;

        // Mark recipient as having collected
        members[recipient].hasCollected = true;
        hasReceivedPayout[recipient] = true;

        // Notify the factory of a successful cycle for the recipient
        ITakturnsFactory(config.factory).recordSuccessfulCycle(recipient);

        // Transfer the pool to the recipient
        IERC20(config.token).safeTransfer(recipient, totalPool);

        emit FundsDistributed(recipient, currentCycle, totalPool);

        // Advance to next cycle or complete the group
        _advanceCycle();
    }

    /**
     * @dev Advances to the next cycle. If all members have collected, completes the group.
     */
    function _advanceCycle() internal {
        currentRecipientIndex += 1;

        // Check if all recipients have been paid (group is complete)
        if (currentRecipientIndex >= collectionOrder.length) {
            _completeGroup();
        } else {
            currentCycle += 1;
            cycleStartTime = block.timestamp;
            contributionsThisCycle = 0;

            emit CycleAdvanced(currentCycle, collectionOrder[currentRecipientIndex]);
        }
    }

    /**
     * @dev Completes the group — refunds all collateral to active members.
     */
    function _completeGroup() internal {
        state = GroupState.Completed;

        emit GroupCompleted(currentCycle);

        // Refund collateral to all active (non-defaulted) members
        for (uint256 i = 0; i < memberAddresses.length; i++) {
            address member = memberAddresses[i];
            MemberInfo storage info = members[member];
            if (info.hasJoined && !info.hasDefaulted && info.collateralDeposited > 0) {
                uint256 refundAmount = info.collateralDeposited;
                info.collateralDeposited = 0;
                IERC20(config.token).safeTransfer(member, refundAmount);
                emit CollateralRefunded(member, refundAmount);
            }
        }
    }

    /**
     * @dev Checks if the group has members of different grades (mixed-grade).
     */
    function _checkMixedGrade() internal view returns (bool) {
        if (memberAddresses.length <= 1) return false;

        ITakturnsFactory factory = ITakturnsFactory(config.factory);
        uint8 firstGrade = factory.getMemberProfile(memberAddresses[0]).grade;

        for (uint256 i = 1; i < memberAddresses.length; i++) {
            uint8 memberGrade = factory.getMemberProfile(memberAddresses[i]).grade;
            if (memberGrade != firstGrade) {
                return true;
            }
        }
        return false;
    }

    /**
     * @dev Builds the collection order based on grade priority rules:
     *      - Same-grade group: highest grade collects first, then by join order
     *      - Mixed-grade group: flat rotation in join order (admin first)
     *
     *      Uses insertion sort — safe for the small member counts we expect (≤20).
     */
    function _buildCollectionOrder() internal {
        uint256 len = memberAddresses.length;
        // Start with join order (admin is memberAddresses[0] since they join first)
        delete collectionOrder;
        for (uint256 i = 0; i < len; i++) {
            collectionOrder.push(memberAddresses[i]);
        }

        if (!isMixedGrade) {
            // Same-grade group: sort by grade descending (highest first), stable by join order
            ITakturnsFactory factory = ITakturnsFactory(config.factory);

            // Insertion sort (stable, O(n²) but n is small)
            for (uint256 i = 1; i < len; i++) {
                address key = collectionOrder[i];
                uint8 keyGrade = factory.getMemberProfile(key).grade;
                uint256 j = i;

                while (
                    j > 0 &&
                    factory.getMemberProfile(collectionOrder[j - 1]).grade < keyGrade
                ) {
                    collectionOrder[j] = collectionOrder[j - 1];
                    j--;
                }
                collectionOrder[j] = key;
            }
        }
        // Mixed-grade: collectionOrder is already in join order (admin first) — no sorting needed
    }

    /**
     * @dev Returns the number of active (non-defaulted) members.
     */
    function _getActiveMemberCount() internal view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 0; i < memberAddresses.length; i++) {
            if (!members[memberAddresses[i]].hasDefaulted) {
                count++;
            }
        }
        return count;
    }
}
