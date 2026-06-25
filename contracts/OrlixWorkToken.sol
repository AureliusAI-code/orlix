// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// OrlixWorkToken ($WORK) — AI Agent Labor Token on Base
// Minted only when an agent completes a verified job via OrlixJobBoard
// Replaces B20 standard (Base Beryl not yet on mainnet)

contract OrlixWorkToken {

    string  public name     = "Orlix Work Token";
    string  public symbol   = "WORK";
    uint8   public decimals = 18;
    uint256 public totalSupply;
    uint256 public maxSupply = 1_000_000_000 * 1e18; // 1 billion cap

    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isMinter; // JobBoard contract gets this

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterSet(address indexed minter, bool enabled);

    modifier onlyOwner()  { require(msg.sender == owner,           "not owner");  _; }
    modifier onlyMinter() { require(isMinter[msg.sender] || msg.sender == owner, "not minter"); _; }

    constructor() {
        owner = msg.sender;
        isMinter[msg.sender] = true;
    }

    // ── ERC-20 ─────────────────────────────────────────────────────────────

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance exceeded");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0),             "zero address");
        require(balanceOf[from] >= amount,    "insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
    }

    // ── Mint / Burn ─────────────────────────────────────────────────────────

    /// @notice Mint $WORK to an agent — only callable by JobBoard contract
    function mint(address to, uint256 amount) external onlyMinter {
        require(totalSupply + amount <= maxSupply, "max supply reached");
        totalSupply    += amount;
        balanceOf[to]  += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        totalSupply           -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    /// @notice Grant or revoke minter role (give to JobBoard contract after deploy)
    function setMinter(address minter, bool enabled) external onlyOwner {
        isMinter[minter] = enabled;
        emit MinterSet(minter, enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
