// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @title Fedrok governance and network parameters
/// @notice Fedrok AG today, a DAO later. Holds the roles every other Fedrok
///         system contract checks: governance admin, accredited auditors,
///         the settlement-stablecoin issuer and the fallback validator, plus
///         the network parameters the Proof of Green engine reads.
contract FedrokGovernance {
    struct Auditor {
        string name;
        uint64 addedAt;
        bool active;
    }

    address public admin;
    address public stableIssuer;
    address public fallbackValidator;

    mapping(address => Auditor) public auditors;
    address[] public auditorList;

    // Network parameters (see setParam for the allowed ranges).
    uint256 public blockTimeMs;
    uint256 public minGasPrice;          // wei of FDK per gas
    uint256 public minGeneratorStake;    // wei of FDK
    uint256 public fdkPerUnitYear;       // wei of FDK per S9-equivalent unit per year
    uint256 public greenWindow;          // Bitcoin blocks
    uint256 public maxGeneratorsPerMiner;
    uint256 public marketFeeBps;
    uint256 public maxTxPerBlock;

    event AuditorAdded(address indexed auditor, string name);
    event AuditorRemoved(address indexed auditor);
    event FallbackValidatorSet(address indexed validator);
    event StableIssuerSet(address indexed issuer);
    event ParamSet(string key, uint256 value);
    event AdminTransferred(address indexed admin);

    struct Params {
        uint256 blockTimeMs;
        uint256 minGasPrice;
        uint256 minGeneratorStake;
        uint256 fdkPerUnitYear;
        uint256 greenWindow;
        uint256 maxGeneratorsPerMiner;
        uint256 marketFeeBps;
        uint256 maxTxPerBlock;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "governance only");
        _;
    }

    constructor(address admin_, address stableIssuer_, address fallback_, Params memory p) {
        admin = admin_;
        stableIssuer = stableIssuer_;
        fallbackValidator = fallback_;
        blockTimeMs = p.blockTimeMs;
        minGasPrice = p.minGasPrice;
        minGeneratorStake = p.minGeneratorStake;
        fdkPerUnitYear = p.fdkPerUnitYear;
        greenWindow = p.greenWindow;
        maxGeneratorsPerMiner = p.maxGeneratorsPerMiner;
        marketFeeBps = p.marketFeeBps;
        maxTxPerBlock = p.maxTxPerBlock;
    }

    function isAuditor(address a) external view returns (bool) {
        return auditors[a].active;
    }

    function auditorCount() external view returns (uint256) {
        return auditorList.length;
    }

    function params() external view returns (Params memory) {
        return Params(blockTimeMs, minGasPrice, minGeneratorStake, fdkPerUnitYear, greenWindow, maxGeneratorsPerMiner, marketFeeBps, maxTxPerBlock);
    }

    function addAuditor(address auditor, string calldata name) external onlyAdmin {
        require(auditor != address(0), "auditor must be a 0x address");
        require(bytes(name).length > 0 && bytes(name).length <= 120, "name is required (max 120 chars)");
        if (auditors[auditor].addedAt == 0) auditorList.push(auditor);
        auditors[auditor] = Auditor(name, uint64(block.timestamp), true);
        emit AuditorAdded(auditor, name);
    }

    function removeAuditor(address auditor) external onlyAdmin {
        require(auditors[auditor].addedAt != 0, "unknown auditor");
        auditors[auditor].active = false;
        emit AuditorRemoved(auditor);
    }

    function setFallbackValidator(address v) external onlyAdmin {
        require(v != address(0), "validator must be a 0x address");
        fallbackValidator = v;
        emit FallbackValidatorSet(v);
    }

    function setStableIssuer(address v) external onlyAdmin {
        require(v != address(0), "issuer must be a 0x address");
        stableIssuer = v;
        emit StableIssuerSet(v);
    }

    function transferAdmin(address v) external onlyAdmin {
        require(v != address(0), "admin must be a 0x address");
        admin = v;
        emit AdminTransferred(v);
    }

    function setParam(string calldata key, uint256 value) external onlyAdmin {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("blockTimeMs")) {
            require(value >= 1000 && value <= 60000 && value % 1000 == 0, "invalid value for blockTimeMs");
            blockTimeMs = value;
        } else if (k == keccak256("minGasPrice")) {
            require(value <= 1e15, "invalid value for minGasPrice");
            minGasPrice = value;
        } else if (k == keccak256("minGeneratorStake")) {
            minGeneratorStake = value;
        } else if (k == keccak256("fdkPerUnitYear")) {
            fdkPerUnitYear = value;
        } else if (k == keccak256("greenWindow")) {
            require(value >= 1 && value <= 1000, "invalid value for greenWindow");
            greenWindow = value;
        } else if (k == keccak256("maxGeneratorsPerMiner")) {
            require(value >= 1 && value <= 101, "invalid value for maxGeneratorsPerMiner");
            maxGeneratorsPerMiner = value;
        } else if (k == keccak256("marketFeeBps")) {
            require(value <= 1000, "invalid value for marketFeeBps");
            marketFeeBps = value;
        } else if (k == keccak256("maxTxPerBlock")) {
            require(value >= 1 && value <= 5000, "invalid value for maxTxPerBlock");
            maxTxPerBlock = value;
        } else {
            revert(string.concat("unknown parameter ", key));
        }
        emit ParamSet(key, value);
    }
}
