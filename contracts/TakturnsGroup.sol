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
 *         collection priority, default resolution, voting, and leave.
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

    // ─── Phase 4 State ──────────────────────────────────────────────────

    // Voting
    bool public votingActive;
    mapping(address => VoteOption) public memberVote;
    uint256 public votesForContinue;
    uint256 public votesForDissolve;

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

    modifier onlyActiveMember() {
        require(members[msg.sender].hasJoined, "TakturnsGroup: Not a member");
        require(!members[msg.sender].hasDefaulted, "TakturnsGroup: Defaulted");
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
    function contribute() external override onlyState(GroupState.Active) onlyActiveMember nonReentrant {
        require(!votingActive, "TakturnsGroup: Voting in progress");
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

    // ─── Phase 4: Default Resolution ────────────────────────────────────

    /**
     * @notice Flag a member who has not contributed by the deadline.
     *         - Seizes their collateral and distributes it among active members.
     *         - Blacklists them in the factory.
     *         - Opens voting for Continue/Dissolve.
     * @param _member The address of the defaulting member.
     */
    function flagDefaulter(address _member) external override onlyState(GroupState.Active) nonReentrant {
        require(!votingActive, "TakturnsGroup: Voting already active");
        require(members[_member].hasJoined, "TakturnsGroup: Not a member");
        require(!members[_member].hasDefaulted, "TakturnsGroup: Already defaulted");
        require(
            block.timestamp >= cycleStartTime + config.cycleDuration,
            "TakturnsGroup: Deadline not reached"
        );
        require(
            !hasContributedThisCycle[currentCycle][_member],
            "TakturnsGroup: Member has contributed"
        );

        MemberInfo storage defaulter = members[_member];
        uint256 seizedCollateral = defaulter.collateralDeposited;

        // --- Effects ---
        defaulter.hasDefaulted = true;
        defaulter.collateralDeposited = 0;

        // Report to factory (blacklists the user, resets consecutive counter)
        ITakturnsFactory(config.factory).reportDefault(_member);

        emit MemberDefaulted(_member, currentCycle, seizedCollateral);

        // --- Distribute seized collateral equally among remaining active members ---
        uint256 activeMemberCount = _getActiveMemberCount();

        if (activeMemberCount > 0 && seizedCollateral > 0) {
            uint256 sharePerMember = seizedCollateral / activeMemberCount;
            uint256 distributed = 0;

            for (uint256 i = 0; i < memberAddresses.length; i++) {
                address member = memberAddresses[i];
                if (members[member].hasJoined && !members[member].hasDefaulted) {
                    // Credit to their collateral balance (they can withdraw when group ends)
                    members[member].collateralDeposited += sharePerMember;
                    distributed += sharePerMember;
                }
            }

            // Handle dust (remainder from integer division) — give to first active member
            uint256 dust = seizedCollateral - distributed;
            if (dust > 0) {
                for (uint256 i = 0; i < memberAddresses.length; i++) {
                    address member = memberAddresses[i];
                    if (members[member].hasJoined && !members[member].hasDefaulted) {
                        members[member].collateralDeposited += dust;
                        break;
                    }
                }
            }
        }

        // --- Remove defaulter from collection order ---
        _removeFromCollectionOrder(_member);

        // --- Open voting ---
        _openVoting();
    }

    // ─── Phase 4: Voting ────────────────────────────────────────────────

    /**
     * @notice Cast a vote to Continue or Dissolve after a default.
     * @param _option The vote: Continue (1) or Dissolve (2).
     */
    function vote(VoteOption _option) external override onlyState(GroupState.Active) onlyActiveMember {
        require(votingActive, "TakturnsGroup: No active vote");
        require(_option == VoteOption.Continue || _option == VoteOption.Dissolve, "TakturnsGroup: Invalid vote");
        require(memberVote[msg.sender] == VoteOption.None, "TakturnsGroup: Already voted");

        memberVote[msg.sender] = _option;

        if (_option == VoteOption.Continue) {
            votesForContinue += 1;
        } else {
            votesForDissolve += 1;
        }

        emit VoteCast(msg.sender, _option);
    }

    /**
     * @notice Resolve the vote once supermajority (>66%) is reached for one option.
     *         Executes the outcome.
     */
    function resolveVote() external override onlyState(GroupState.Active) nonReentrant {
        require(votingActive, "TakturnsGroup: No active vote");

        uint256 activeMemberCount = _getActiveMemberCount();
        // Supermajority threshold: strictly more than 66% of active members
        // Using (votes * 3 > activeMemberCount * 2) to avoid floating point
        bool continueWins = (votesForContinue * 3) > (activeMemberCount * 2);
        bool dissolveWins = (votesForDissolve * 3) > (activeMemberCount * 2);

        require(continueWins || dissolveWins, "TakturnsGroup: Supermajority not reached");

        votingActive = false;

        if (continueWins) {
            emit VoteResolved(VoteOption.Continue);
            _handleContinue();
        } else {
            emit VoteResolved(VoteOption.Dissolve);
            _handleDissolve();
        }
    }

    // ─── Phase 4: Leave ─────────────────────────────────────────────────

    /**
     * @notice Leave the group voluntarily.
     *         - During Pending: full collateral refund.
     *         - During Active: collateral returned, current cycle contribution forfeited.
     *         - Reverts if the member has already received a payout (you owe the group).
     */
    function leaveGroup() external override onlyMember nonReentrant {
        require(!members[msg.sender].hasDefaulted, "TakturnsGroup: Already defaulted");
        require(!hasReceivedPayout[msg.sender], "TakturnsGroup: Cannot leave after receiving payout");
        require(
            state == GroupState.Pending || state == GroupState.Active,
            "TakturnsGroup: Cannot leave in current state"
        );

        MemberInfo storage info = members[msg.sender];
        uint256 collateralToReturn = info.collateralDeposited;

        // Mark as defaulted (effectively removed from active participation)
        info.hasDefaulted = true;
        info.collateralDeposited = 0;

        // If active, remove from collection order
        if (state == GroupState.Active) {
            _removeFromCollectionOrder(msg.sender);
        }

        // Return collateral
        if (collateralToReturn > 0) {
            IERC20(config.token).safeTransfer(msg.sender, collateralToReturn);
        }

        emit MemberLeft(msg.sender, collateralToReturn);
    }

    // ─── Phase 4: Emergency ─────────────────────────────────────────────

    /**
     * @notice Admin-only emergency circuit breaker.
     *         Returns all held funds proportionally to active members.
     *         Can only be used when the group is Active or when voting is stuck.
     */
    function emergencyRefund() external override onlyAdmin nonReentrant {
        require(
            state == GroupState.Active || state == GroupState.Pending,
            "TakturnsGroup: Cannot emergency refund in current state"
        );

        uint256 totalBalance = IERC20(config.token).balanceOf(address(this));
        require(totalBalance > 0, "TakturnsGroup: No funds to refund");

        uint256 activeMemberCount = _getActiveMemberCount();
        require(activeMemberCount > 0, "TakturnsGroup: No active members");

        state = GroupState.Dissolved;

        emit EmergencyRefund(msg.sender, currentCycle);
        emit GroupDissolved(currentCycle);

        // Distribute all remaining funds equally
        uint256 sharePerMember = totalBalance / activeMemberCount;
        uint256 distributed = 0;

        for (uint256 i = 0; i < memberAddresses.length; i++) {
            address member = memberAddresses[i];
            if (members[member].hasJoined && !members[member].hasDefaulted) {
                members[member].collateralDeposited = 0;
                IERC20(config.token).safeTransfer(member, sharePerMember);
                distributed += sharePerMember;
            }
        }

        // Handle dust — send to admin
        uint256 dust = totalBalance - distributed;
        if (dust > 0) {
            IERC20(config.token).safeTransfer(config.admin, dust);
        }
    }

    // ─── View Functions ─────────────────────────────────────────────────

    function getCurrentRecipient() external view override returns (address) {
        require(state == GroupState.Active, "TakturnsGroup: Not active");
        require(currentRecipientIndex < collectionOrder.length, "TakturnsGroup: No more recipients");
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

    /**
     * @notice Returns the current voting status.
     */
    function getVotingStatus() external view returns (
        bool isActive,
        uint256 forContinue,
        uint256 forDissolve,
        uint256 activeMembers
    ) {
        isActive = votingActive;
        forContinue = votesForContinue;
        forDissolve = votesForDissolve;
        activeMembers = _getActiveMemberCount();
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
     * @dev Opens voting after a default event. Resets all prior votes.
     */
    function _openVoting() internal {
        votingActive = true;
        votesForContinue = 0;
        votesForDissolve = 0;

        // Reset all member votes
        for (uint256 i = 0; i < memberAddresses.length; i++) {
            memberVote[memberAddresses[i]] = VoteOption.None;
        }

        uint256 activeMemberCount = _getActiveMemberCount();
        emit VotingOpened(currentCycle, activeMemberCount);
    }

    /**
     * @dev Handles the Continue outcome — adjusts the rotation and resumes.
     *      The defaulter has already been removed from collectionOrder in flagDefaulter().
     *      Reset cycleStartTime to give a fresh deadline for contributions.
     */
    function _handleContinue() internal {
        // Reset contributions for the current cycle (members may need to re-contribute
        // since the pool changed). But if members already contributed this cycle,
        // we keep their contributions and just reset the counter to match.
        // Actually, contributions already made this cycle stay valid.
        // We just resume: reset the cycle timer so remaining members can contribute.
        cycleStartTime = block.timestamp;

        // If all active members have already contributed, auto-distribute
        uint256 activeMemberCount = _getActiveMemberCount();
        if (contributionsThisCycle >= activeMemberCount && activeMemberCount > 0) {
            _distributeFunds();
        }
    }

    /**
     * @dev Handles the Dissolve outcome — refunds all active members proportionally.
     */
    function _handleDissolve() internal {
        state = GroupState.Dissolved;
        emit GroupDissolved(currentCycle);

        uint256 totalBalance = IERC20(config.token).balanceOf(address(this));
        uint256 activeMemberCount = _getActiveMemberCount();

        if (activeMemberCount > 0 && totalBalance > 0) {
            uint256 sharePerMember = totalBalance / activeMemberCount;
            uint256 distributed = 0;

            for (uint256 i = 0; i < memberAddresses.length; i++) {
                address member = memberAddresses[i];
                if (members[member].hasJoined && !members[member].hasDefaulted) {
                    members[member].collateralDeposited = 0;
                    IERC20(config.token).safeTransfer(member, sharePerMember);
                    distributed += sharePerMember;
                }
            }

            // Handle dust
            uint256 dust = totalBalance - distributed;
            if (dust > 0) {
                for (uint256 i = 0; i < memberAddresses.length; i++) {
                    address member = memberAddresses[i];
                    if (members[member].hasJoined && !members[member].hasDefaulted) {
                        IERC20(config.token).safeTransfer(member, dust);
                        break;
                    }
                }
            }
        }
    }

    /**
     * @dev Removes a member from the collection order array.
     */
    function _removeFromCollectionOrder(address _member) internal {
        uint256 len = collectionOrder.length;
        for (uint256 i = 0; i < len; i++) {
            if (collectionOrder[i] == _member) {
                // Shift elements left
                for (uint256 j = i; j < len - 1; j++) {
                    collectionOrder[j] = collectionOrder[j + 1];
                }
                collectionOrder.pop();

                // Adjust currentRecipientIndex if the removed member was before or at the current index
                if (i < currentRecipientIndex) {
                    currentRecipientIndex -= 1;
                }
                break;
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
