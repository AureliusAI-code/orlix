// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * ORLIXStaking — 30-day lock staking with burn mechanic
 *
 * Tiers:
 *   Tier 1: 3M  ORLIX staked → $3/day AI credits
 *   Tier 2: 10M ORLIX staked → $5/day AI credits
 *   Tier 3: 50M ORLIX staked → $10/day AI credits
 *
 * Burn mechanic: platform calls burnFromFee() to burn ORLIX
 * proportional to AI inference usage.
 */
contract ORLIXStaking {
    IERC20 public immutable orlix;
    address public owner;

    uint256 public constant LOCK_PERIOD = 30 days;
    uint256 public constant BURN_ADDRESS_DEAD = 0;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Tier thresholds in ORLIX (18 decimals)
    uint256 public constant TIER_1_MIN =  3_000_000 * 1e18;
    uint256 public constant TIER_2_MIN = 10_000_000 * 1e18;
    uint256 public constant TIER_3_MIN = 50_000_000 * 1e18;

    struct StakeInfo {
        uint256 amount;
        uint256 stakedAt;
        uint256 unlocksAt;
    }

    mapping(address => StakeInfo) public stakes;

    uint256 public totalStaked;
    uint256 public totalBurned;

    event Staked(address indexed user, uint256 amount, uint256 unlocksAt);
    event Unstaked(address indexed user, uint256 amount);
    event Burned(uint256 amount, uint256 totalBurned);
    event OwnerChanged(address newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _orlix) {
        orlix = IERC20(_orlix);
        owner = msg.sender;
    }

    // ── Staking ───────────────────────────────────────────────────────────────

    function stake(uint256 amount) external {
        require(amount >= TIER_1_MIN, "Minimum 3M ORLIX to stake");
        require(orlix.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        StakeInfo storage s = stakes[msg.sender];
        s.amount    += amount;
        s.stakedAt   = block.timestamp;
        s.unlocksAt  = block.timestamp + LOCK_PERIOD;
        totalStaked += amount;

        emit Staked(msg.sender, amount, s.unlocksAt);
    }

    function unstake() external {
        StakeInfo storage s = stakes[msg.sender];
        require(s.amount > 0,                    "Nothing staked");
        require(block.timestamp >= s.unlocksAt,  "Still locked — 30 day lock active");

        uint256 amount = s.amount;
        s.amount    = 0;
        s.stakedAt  = 0;
        s.unlocksAt = 0;
        totalStaked -= amount;

        require(orlix.transfer(msg.sender, amount), "Transfer failed");
        emit Unstaked(msg.sender, amount);
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    function getStake(address user) external view returns (
        uint256 amount,
        uint256 unlocksAt,
        bool    unlocked,
        uint8   tier        // 0=none 1=tier1 2=tier2 3=tier3
    ) {
        StakeInfo memory s = stakes[user];
        amount    = s.amount;
        unlocksAt = s.unlocksAt;
        unlocked  = s.unlocksAt > 0 && block.timestamp >= s.unlocksAt;
        tier      = s.amount >= TIER_3_MIN ? 3 :
                    s.amount >= TIER_2_MIN ? 2 :
                    s.amount >= TIER_1_MIN ? 1 : 0;
    }

    function getStakeTier(address user) external view returns (uint8) {
        uint256 amount = stakes[user].amount;
        if (amount >= TIER_3_MIN) return 3;
        if (amount >= TIER_2_MIN) return 2;
        if (amount >= TIER_1_MIN) return 1;
        return 0;
    }

    // ── Burn mechanic ─────────────────────────────────────────────────────────
    // Called by platform backend when AI inference credits are consumed.
    // Sends ORLIX from platform treasury to dead address.

    function burnFromFee(uint256 amount) external onlyOwner {
        require(orlix.transfer(DEAD, amount), "Burn failed");
        totalBurned += amount;
        emit Burned(amount, totalBurned);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    // Emergency: recover any accidentally sent tokens (not ORLIX staked)
    function recoverToken(address token, uint256 amount) external onlyOwner {
        require(token != address(orlix), "Cannot recover staked ORLIX");
        IERC20(token).transfer(owner, amount);
    }
}
