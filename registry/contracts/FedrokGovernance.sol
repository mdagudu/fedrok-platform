// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @title Fedrok governance, validator set and network parameters
/// @notice Fedrok AG today, a DAO later. Holds the roles the other Fedrok
///         system contracts check (governance admin, settlement-stablecoin
///         issuer), the authority validator set that produces blocks, and the
///         network parameters.
///
///         Block production is Proof of Authority: the validators listed
///         here take turns, one time slot each (slot = timestamp / blockTime,
///         leader = validators[slot % count]). Every node reads this list and
///         rejects blocks sealed by anyone else.
contract FedrokGovernance {
    address public admin;
    address public stableIssuer;

    address[] public validators;
    mapping(address => string) public validatorName;

    uint256 public blockTimeMs;
    uint256 public minGasPrice;   // wei of FDK per gas
    uint256 public maxTxPerBlock;

    event ValidatorAdded(address indexed validator, string name);
    event ValidatorRemoved(address indexed validator);
    event StableIssuerSet(address indexed issuer);
    event ParamSet(string key, uint256 value);
    event AdminTransferred(address indexed admin);

    struct Params {
        uint256 blockTimeMs;
        uint256 minGasPrice;
        uint256 maxTxPerBlock;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "governance only");
        _;
    }

    constructor(address admin_, address stableIssuer_, address[] memory validators_, string[] memory names_, Params memory p) {
        require(validators_.length > 0 && validators_.length == names_.length, "at least one named validator is required");
        admin = admin_;
        stableIssuer = stableIssuer_;
        for (uint256 i = 0; i < validators_.length; i++) _addValidator(validators_[i], names_[i]);
        blockTimeMs = p.blockTimeMs;
        minGasPrice = p.minGasPrice;
        maxTxPerBlock = p.maxTxPerBlock;
    }

    function params() external view returns (Params memory) {
        return Params(blockTimeMs, minGasPrice, maxTxPerBlock);
    }

    function validatorCount() external view returns (uint256) {
        return validators.length;
    }

    function validatorList() external view returns (address[] memory) {
        return validators;
    }

    function isValidator(address v) public view returns (bool) {
        return bytes(validatorName[v]).length > 0;
    }

    function _addValidator(address v, string memory name) internal {
        require(v != address(0), "validator must be a 0x address");
        require(bytes(name).length > 0 && bytes(name).length <= 80, "validator name is required (max 80 chars)");
        require(!isValidator(v), "already a validator");
        validators.push(v);
        validatorName[v] = name;
        emit ValidatorAdded(v, name);
    }

    function addValidator(address v, string calldata name) external onlyAdmin {
        _addValidator(v, name);
    }

    function removeValidator(address v) external onlyAdmin {
        require(isValidator(v), "unknown validator");
        require(validators.length > 1, "the network needs at least one validator");
        for (uint256 i = 0; i < validators.length; i++) {
            if (validators[i] == v) {
                validators[i] = validators[validators.length - 1];
                validators.pop();
                break;
            }
        }
        delete validatorName[v];
        emit ValidatorRemoved(v);
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
        } else if (k == keccak256("maxTxPerBlock")) {
            require(value >= 1 && value <= 5000, "invalid value for maxTxPerBlock");
            maxTxPerBlock = value;
        } else {
            revert(string.concat("unknown parameter ", key));
        }
        emit ParamSet(key, value);
    }
}
