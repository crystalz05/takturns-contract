// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./interfaces/ITakturnsFactory.sol";
import "./interfaces/ITakturnsGroup.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title TakturnsFactory
 * @notice Factory for deploying Takturns groups and managing the global reputation system.
 */
contract TakturnsFactory is ITakturnsFactory {
    // --- State Variables ---

    address public immutable groupImplementation;
    
    // Global Reputation Mapping
    mapping(address => MemberProfile) private _memberProfiles;
    
    // Grade Definitions
    mapping(uint8 => GradeRules) private _gradeRules;

    // Registry of created groups
    address[] public allGroups;
    mapping(address => bool) public isGroup;

    // Constants
    uint8 public constant MAX_GRADE = 4;
    uint256 public constant PROMOTION_THRESHOLD = 3; // 3 consecutive cycles for promotion
    uint256 private constant USDC_DECIMALS = 1e6; // USDC has 6 decimals

    // --- Modifiers ---

    modifier onlyGroup() {
        require(isGroup[msg.sender], "TakturnsFactory: Caller is not a registered group");
        _;
    }

    // --- Constructor ---

    constructor(address _groupImplementation) {
        require(_groupImplementation != address(0), "Invalid implementation");
        groupImplementation = _groupImplementation;

        // Initialize Grade Rules (USDC values)
        _gradeRules[1] = GradeRules({
            minContribution: 5 * USDC_DECIMALS,
            maxContribution: 30 * USDC_DECIMALS,
            collateralPercent: 150
        });

        _gradeRules[2] = GradeRules({
            minContribution: 31 * USDC_DECIMALS,
            maxContribution: 100 * USDC_DECIMALS,
            collateralPercent: 100
        });

        _gradeRules[3] = GradeRules({
            minContribution: 101 * USDC_DECIMALS,
            maxContribution: 400 * USDC_DECIMALS,
            collateralPercent: 67
        });

        _gradeRules[4] = GradeRules({
            minContribution: 401 * USDC_DECIMALS,
            maxContribution: 2000 * USDC_DECIMALS,
            collateralPercent: 50
        });
    }

    // --- View Functions ---

    function getGradeRules(uint8 _grade) external view override returns (GradeRules memory) {
        require(_grade > 0 && _grade <= MAX_GRADE, "TakturnsFactory: Invalid grade");
        return _gradeRules[_grade];
    }

    function getMemberProfile(address _user) external view override returns (MemberProfile memory) {
        MemberProfile memory profile = _memberProfiles[_user];
        // Default grade is 1 for new users
        if (profile.grade == 0) {
            profile.grade = 1;
        }
        return profile;
    }

    function getCollateralAmount(uint256 _contribution, uint8 _minGrade) external view override returns (uint256) {
        require(_minGrade > 0 && _minGrade <= MAX_GRADE, "TakturnsFactory: Invalid grade");
        GradeRules memory rules = _gradeRules[_minGrade];
        return (_contribution * rules.collateralPercent) / 100;
    }

    /**
     * @notice Checks if a user can join a group with the given minimum grade.
     * @param _user The user's address.
     * @param _minGrade The minimum grade required by the group.
     * @return True if the user can join.
     */
    function canJoinGroup(address _user, uint8 _minGrade) external view returns (bool) {
        MemberProfile memory profile = _memberProfiles[_user];
        if (profile.isBlacklisted) return false;
        uint8 effectiveGrade = profile.grade == 0 ? 1 : profile.grade;
        return effectiveGrade >= _minGrade;
    }

    // --- State-Modifying Functions ---

    function createGroup(
        uint8 _minGrade,
        uint256 _contribution,
        uint256 _cycleDuration,
        uint256 _maxMembers,
        address _token
    ) external override returns (address) {
        require(_minGrade > 0 && _minGrade <= MAX_GRADE, "TakturnsFactory: Invalid grade");
        require(_maxMembers > 1, "TakturnsFactory: Max members must be > 1");
        
        // Validate contribution falls within grade limits
        GradeRules memory rules = _gradeRules[_minGrade];
        require(
            _contribution >= rules.minContribution && _contribution <= rules.maxContribution,
            "TakturnsFactory: Contribution out of bounds for grade"
        );

        // Ensure creator is not blacklisted
        MemberProfile memory creatorProfile = _memberProfiles[msg.sender];
        require(!creatorProfile.isBlacklisted, "TakturnsFactory: Creator is blacklisted");
        
        // Use OpenZeppelin Clones to deploy a minimal proxy
        address clone = Clones.clone(groupImplementation);
        
        // Initialize the new group
        ITakturnsGroup(clone).initialize(
            msg.sender,
            address(this),
            _token,
            _minGrade,
            _contribution,
            _cycleDuration,
            _maxMembers
        );

        // Register the group
        allGroups.push(clone);
        isGroup[clone] = true;

        emit GroupCreated(clone, msg.sender, _minGrade, _token);

        return clone;
    }

    function recordSuccessfulCycle(address _user) external override onlyGroup {
        MemberProfile storage profile = _memberProfiles[_user];
        
        // If it's a new user, set their grade to 1
        if (profile.grade == 0) {
            profile.grade = 1;
        }

        profile.consecutiveCompletions += 1;
        emit ConsecutiveCompletionRecorded(_user, profile.consecutiveCompletions);

        // Check for promotion
        if (profile.consecutiveCompletions >= PROMOTION_THRESHOLD && profile.grade < MAX_GRADE) {
            profile.grade += 1;
            profile.consecutiveCompletions = 0; // Reset after promotion? PRD doesn't explicitly say to reset after promotion, but typically you need 3 MORE for the next grade. Let's reset.
            emit MemberPromoted(_user, profile.grade);
        }
    }

    function reportDefault(address _user) external override onlyGroup {
        MemberProfile storage profile = _memberProfiles[_user];
        
        if (profile.grade == 0) {
            profile.grade = 1;
        }

        profile.consecutiveCompletions = 0;
        profile.isBlacklisted = true;
        
        emit MemberBlacklisted(_user, msg.sender);
    }
}
