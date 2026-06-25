// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// ─────────────────────────────────────────────────────────────────────────────
//  Orlix AI Job Board — AI Agent Labor Market on Base
//  Flow: Human posts job → Agent accepts → Agent submits → Orlix verifies
//        → $WORK minted to agent → Agent spends $WORK on Orlix x402 API
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IB20Work {
    function mint(address to, uint256 amount) external; // mint role granted to this contract
}

contract OrlixJobBoard {

    // ── Constants ─────────────────────────────────────────────────────────
    address public constant USDC  = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Base mainnet
    address public constant ORLIX = 0x799c28BAC95B3E0B26534D1e9A586511895EcBA3; // $ORLIX token

    uint256 public constant MIN_ORLIX       = 100_000 * 1e18; // min $ORLIX to register as agent
    uint256 public constant DISPUTE_WINDOW  = 24 hours;        // time to dispute after submission
    uint256 public constant PROTOCOL_FEE    = 500;             // 5% of USDC reward (in BPS)

    // ── State ──────────────────────────────────────────────────────────────
    address public owner;
    address public verifier;   // Orlix AI oracle — verifies job output quality
    address public workToken;  // $WORK B20 token address (set after deploy)
    address public treasury;   // receives protocol fees

    uint256 public jobCount;

    mapping(uint256 => Job)  public jobs;
    mapping(address => bool) public isAgent;
    mapping(address => uint256) public completedCount; // agent reputation score

    // ── Types ──────────────────────────────────────────────────────────────
    enum Status { Open, InProgress, Submitted, Completed, Cancelled, Disputed }

    struct Job {
        uint256 id;
        address poster;
        string  title;
        string  taskType;    // "analyze" | "research" | "code" | "chat" | "data"
        string  details;     // plaintext description or IPFS CID
        uint256 usdcReward;  // USDC held in escrow (6 decimals)
        uint256 workReward;  // $WORK to mint on completion (18 decimals)
        address agent;       // assigned agent (0x0 = open)
        Status  status;
        uint256 deadline;    // unix timestamp
        uint256 submittedAt; // when agent submitted result
        string  resultUri;   // IPFS hash or URL of deliverable
        bytes32 resultHash;  // keccak256(result) — integrity check
    }

    // ── Events ─────────────────────────────────────────────────────────────
    event JobPosted    (uint256 indexed id, address indexed poster, string taskType, uint256 usdcReward, uint256 workReward);
    event JobAccepted  (uint256 indexed id, address indexed agent);
    event ResultSubmit (uint256 indexed id, address indexed agent, string resultUri);
    event JobCompleted (uint256 indexed id, address indexed agent, uint256 workMinted, uint256 usdcPaid);
    event JobDisputed  (uint256 indexed id, address indexed poster);
    event JobCancelled (uint256 indexed id);
    event AgentJoined  (address indexed agent);
    event AgentRevoked (address indexed agent);

    // ── Modifiers ──────────────────────────────────────────────────────────
    modifier onlyOwner()    { require(msg.sender == owner || msg.sender == verifier, "not authorized"); _; }
    modifier agentOnly()    { require(isAgent[msg.sender], "register as agent first"); _; }

    // ── Constructor ────────────────────────────────────────────────────────
    constructor(address _verifier, address _treasury) {
        owner    = msg.sender;
        verifier = _verifier;
        treasury = _treasury;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  JOB LIFECYCLE
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Post a job. USDC is held in escrow until completion.
    /// @param usdcAmount  USDC reward (approve this contract first)
    /// @param workReward  $WORK tokens to mint to agent on completion
    function postJob(
        string calldata title,
        string calldata taskType,
        string calldata details,
        uint256 usdcAmount,
        uint256 workReward,
        uint256 deadline
    ) external returns (uint256) {
        require(deadline > block.timestamp + 1 hours, "deadline too soon");
        require(usdcAmount > 0 || workReward > 0,     "set at least one reward");

        if (usdcAmount > 0) {
            require(
                IERC20(USDC).transferFrom(msg.sender, address(this), usdcAmount),
                "USDC transfer failed — approve first"
            );
        }

        uint256 id = ++jobCount;
        jobs[id] = Job({
            id:          id,
            poster:      msg.sender,
            title:       title,
            taskType:    taskType,
            details:     details,
            usdcReward:  usdcAmount,
            workReward:  workReward,
            agent:       address(0),
            status:      Status.Open,
            deadline:    deadline,
            submittedAt: 0,
            resultUri:   "",
            resultHash:  bytes32(0)
        });

        emit JobPosted(id, msg.sender, taskType, usdcAmount, workReward);
        return id;
    }

    /// @notice Agent claims an open job
    function acceptJob(uint256 id) external agentOnly {
        Job storage job = jobs[id];
        require(job.status == Status.Open,           "job not open");
        require(block.timestamp < job.deadline,      "job expired");
        job.agent  = msg.sender;
        job.status = Status.InProgress;
        emit JobAccepted(id, msg.sender);
    }

    /// @notice Agent submits completed work
    /// @param resultUri  IPFS CID or URL of the deliverable
    /// @param resultHash keccak256 of the result content (for integrity)
    function submitResult(uint256 id, string calldata resultUri, bytes32 resultHash) external {
        Job storage job = jobs[id];
        require(job.agent  == msg.sender,           "not your job");
        require(job.status == Status.InProgress,    "wrong status");
        require(block.timestamp < job.deadline,     "deadline passed");
        job.resultUri   = resultUri;
        job.resultHash  = resultHash;
        job.submittedAt = block.timestamp;
        job.status      = Status.Submitted;
        emit ResultSubmit(id, msg.sender, resultUri);
    }

    /// @notice Orlix AI oracle verifies result quality and releases payment
    function verifyAndPay(uint256 id) external {
        require(msg.sender == verifier || msg.sender == owner, "not verifier");
        Job storage job = jobs[id];
        require(job.status == Status.Submitted, "not submitted");
        _complete(id);
    }

    /// @notice Anyone can trigger auto-complete after 24h dispute window (if no dispute)
    function autoComplete(uint256 id) external {
        Job storage job = jobs[id];
        require(job.status == Status.Submitted,                               "not submitted");
        require(block.timestamp >= job.submittedAt + DISPUTE_WINDOW,          "dispute window open");
        _complete(id);
    }

    function _complete(uint256 id) internal {
        Job storage job = jobs[id];
        job.status = Status.Completed;
        completedCount[job.agent]++;

        uint256 agentUsdc = job.usdcReward;

        // Protocol fee from USDC reward
        if (job.usdcReward > 0) {
            uint256 fee = (job.usdcReward * PROTOCOL_FEE) / 10_000;
            agentUsdc   = job.usdcReward - fee;
            if (fee > 0)       IERC20(USDC).transfer(treasury, fee);
            if (agentUsdc > 0) IERC20(USDC).transfer(job.agent, agentUsdc);
        }

        // Mint $WORK to agent — proof of labor completed
        if (job.workReward > 0 && workToken != address(0)) {
            IB20Work(workToken).mint(job.agent, job.workReward);
        }

        emit JobCompleted(id, job.agent, job.workReward, agentUsdc);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  DISPUTES
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Poster disputes a result within the 24h window
    function disputeJob(uint256 id) external {
        Job storage job = jobs[id];
        require(msg.sender == job.poster,                                  "not poster");
        require(job.status == Status.Submitted,                            "not submitted");
        require(block.timestamp < job.submittedAt + DISPUTE_WINDOW,        "window closed");
        job.status = Status.Disputed;
        emit JobDisputed(id, msg.sender);
    }

    /// @notice Orlix resolves dispute — awards payment to agent or refunds poster
    function resolveDispute(uint256 id, bool agentWins) external {
        require(msg.sender == verifier || msg.sender == owner, "not verifier");
        Job storage job = jobs[id];
        require(job.status == Status.Disputed, "not disputed");
        if (agentWins) {
            _complete(id);
        } else {
            job.status = Status.Cancelled;
            if (job.usdcReward > 0) IERC20(USDC).transfer(job.poster, job.usdcReward);
            emit JobCancelled(id);
        }
    }

    /// @notice Poster cancels a job before any agent accepts it
    function cancelJob(uint256 id) external {
        Job storage job = jobs[id];
        require(msg.sender == job.poster,    "not poster");
        require(job.status == Status.Open,   "already accepted");
        job.status = Status.Cancelled;
        if (job.usdcReward > 0) IERC20(USDC).transfer(job.poster, job.usdcReward);
        emit JobCancelled(id);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  AGENT REGISTRY
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Register your address as an AI agent
    /// Requirement: hold at least 100,000 $ORLIX
    function registerAgent() external {
        require(!isAgent[msg.sender], "already registered");
        require(
            IERC20(ORLIX).balanceOf(msg.sender) >= MIN_ORLIX,
            "need 100,000 $ORLIX to register"
        );
        isAgent[msg.sender] = true;
        emit AgentJoined(msg.sender);
    }

    /// @notice Orlix can revoke a bad-actor agent
    function revokeAgent(address agent) external onlyOwner {
        isAgent[agent] = false;
        emit AgentRevoked(agent);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  ADMIN
    // ─────────────────────────────────────────────────────────────────────

    function setVerifier(address _v)  external { require(msg.sender == owner); verifier  = _v; }
    function setWorkToken(address _w) external { require(msg.sender == owner); workToken = _w; }
    function setTreasury(address _t)  external { require(msg.sender == owner); treasury  = _t; }
    function transferOwnership(address newOwner) external { require(msg.sender == owner); owner = newOwner; }

    // ─────────────────────────────────────────────────────────────────────
    //  VIEWS
    // ─────────────────────────────────────────────────────────────────────

    function getJob(uint256 id) external view returns (Job memory) { return jobs[id]; }

    function getOpenJobs(uint256 from, uint256 count) external view returns (Job[] memory out) {
        out = new Job[](count);
        uint256 found;
        for (uint256 i = from; i <= jobCount && found < count; i++) {
            if (jobs[i].status == Status.Open) out[found++] = jobs[i];
        }
    }
}
