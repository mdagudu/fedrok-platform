// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IRegistryGov {
    function admin() external view returns (address);
    function isAuditor(address a) external view returns (bool);
}

interface IFDKIssuer {
    function issue(address to, uint256 amount, string calldata reason) external;
    function burn(string calldata reason) external payable;
}

interface IERC1155Receiver {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data) external returns (bytes4);
}

/// @title Fedrok environmental asset registry (carbon credits)
/// @notice ERC-1155: each verified credit batch is a token id and balances are
///         kilograms of CO2e (1 tonne = 1000 units). Only accredited auditors
///         issue. A registry serial range can be tokenised once (double
///         counting is blocked on-chain). Retirement burns the credits and
///         records the beneficiary permanently.
contract CarbonRegistry {
    uint256 public constant KG_TO_FDK = 1e15; // 1 tonne backs 1 FDK (18 decimals)

    struct BatchInput {
        string project;
        string country;
        string registry;
        string methodology;
        string projectType;
        uint16 vintage;
        string serial;
        string description;
    }

    struct Batch {
        string project;
        string country;
        string registry;
        string methodology;
        string projectType;
        uint16 vintage;
        string serial;
        string description;
        address auditor;
        uint256 issuedKg;
        uint256 retiredKg;
        uint256 backingKg;
        uint64 issuedAt;
    }

    struct Retirement {
        uint256 batchId;
        uint256 quantityKg;
        string beneficiary;
        string reason;
        address retiredBy;
        uint64 timestamp;
    }

    address public immutable governance;
    IFDKIssuer public immutable fdkIssuer;
    address public marketplace;

    uint256 public batchCount;
    uint256 public retirementCount;
    uint256 public totalIssuedKg;
    uint256 public totalRetiredKg;
    uint256 public totalBackingKg;

    mapping(uint256 => Batch) internal _batches;
    mapping(uint256 => Retirement) public retirements;
    mapping(uint256 => uint256) public backingVault;
    mapping(bytes32 => uint256) public serialToBatch;
    mapping(uint256 => mapping(address => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);
    event CreditsIssued(uint256 indexed batchId, address indexed auditor, address indexed to, uint256 quantityKg);
    event CreditsRetired(uint256 indexed retirementId, uint256 indexed batchId, address indexed retiredBy, uint256 quantityKg, string beneficiary, string reason);
    event FdkBackMinted(uint256 indexed batchId, address indexed auditor, address indexed to, uint256 quantityKg, uint256 amount);
    event MarketplaceSet(address marketplace);

    constructor(address governance_, address fdkIssuer_) {
        governance = governance_;
        fdkIssuer = IFDKIssuer(fdkIssuer_);
    }

    modifier onlyAuditor(string memory what) {
        require(IRegistryGov(governance).isAuditor(msg.sender), string.concat("only an accredited auditor can ", what));
        _;
    }

    function setMarketplace(address m) external {
        require(msg.sender == IRegistryGov(governance).admin(), "governance only");
        marketplace = m;
        emit MarketplaceSet(m);
    }

    function batches(uint256 id) external view returns (Batch memory) {
        return _batches[id];
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0xd9b67a26 || id == 0x01ffc9a7; // ERC-1155, ERC-165
    }

    function uri(uint256) external pure returns (string memory) {
        return "fedrok://carbon-batch/{id}";
    }

    // ------------------------------------------------------------ issuance
    function issue(address to, uint256 quantityKg, BatchInput calldata b) external onlyAuditor("issue carbon credits") returns (uint256 id) {
        require(quantityKg > 0, "quantityKg must be greater than zero");
        _req(b.project, "project", 200);
        _req(b.country, "country", 80);
        _req(b.registry, "registry", 80);
        _req(b.methodology, "methodology", 120);
        _req(b.projectType, "projectType", 80);
        _req(b.serial, "serial", 160);
        require(bytes(b.description).length <= 1000, "description too long");
        require(b.vintage >= 1990 && b.vintage <= 2100, "vintage must be a year");
        bytes32 key = keccak256(abi.encode(b.registry, b.serial));
        require(serialToBatch[key] == 0, "serial already tokenised (double counting blocked)");
        if (to == address(0)) to = msg.sender;
        id = ++batchCount;
        serialToBatch[key] = id;
        _batches[id] = Batch(b.project, b.country, b.registry, b.methodology, b.projectType, b.vintage, b.serial, b.description, msg.sender, quantityKg, 0, 0, uint64(block.timestamp));
        totalIssuedKg += quantityKg;
        balanceOf[id][to] += quantityKg;
        emit TransferSingle(msg.sender, address(0), to, id, quantityKg);
        emit CreditsIssued(id, msg.sender, to, quantityKg);
    }

    // ------------------------------------------------------------ transfers
    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external {
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "not owner nor approved");
        _move(from, to, id, value);
        if (to.code.length > 0) {
            require(IERC1155Receiver(to).onERC1155Received(msg.sender, from, id, value, data) == IERC1155Receiver.onERC1155Received.selector, "receiver rejected credits");
        }
    }

    /// @dev Escrow moves for the governance-designated marketplace.
    function marketTransfer(address from, address to, uint256 id, uint256 value) external {
        require(msg.sender == marketplace && marketplace != address(0), "marketplace only");
        _move(from, to, id, value);
    }

    // ------------------------------------------------------------ retirement
    function retire(uint256 batchId, uint256 quantityKg, string calldata beneficiary, string calldata reason) external returns (uint256 rid) {
        require(batchId > 0 && batchId <= batchCount, "unknown batch");
        _req(beneficiary, "beneficiary", 200);
        _req(reason, "reason", 300);
        _burn(msg.sender, batchId, quantityKg);
        _batches[batchId].retiredKg += quantityKg;
        totalRetiredKg += quantityKg;
        rid = ++retirementCount;
        retirements[rid] = Retirement(batchId, quantityKg, beneficiary, reason, msg.sender, uint64(block.timestamp));
        emit CreditsRetired(rid, batchId, msg.sender, quantityKg, beneficiary, reason);
    }

    // ------------------------------------------------------------ back-minting
    /// @notice An auditor locks verified credits in the backing vault and FDK
    ///         is issued 1:1 per tonne. FDK stays a utility token.
    function backMint(uint256 batchId, uint256 quantityKg, address to) external onlyAuditor("back-mint FDK") {
        require(batchId > 0 && batchId <= batchCount, "unknown batch");
        if (to == address(0)) to = msg.sender;
        _burn(msg.sender, batchId, quantityKg);
        backingVault[batchId] += quantityKg;
        _batches[batchId].backingKg += quantityKg;
        totalBackingKg += quantityKg;
        uint256 amount = quantityKg * KG_TO_FDK;
        fdkIssuer.issue(to, amount, "back-mint");
        emit FdkBackMinted(batchId, msg.sender, to, quantityKg, amount);
    }

    // ------------------------------------------------------------ internals
    function _move(address from, address to, uint256 id, uint256 value) internal {
        require(id > 0 && id <= batchCount, "unknown batch");
        require(to != address(0), "to must be a 0x address");
        require(value > 0, "quantityKg must be greater than zero");
        require(balanceOf[id][from] >= value, "insufficient credits in batch");
        balanceOf[id][from] -= value;
        balanceOf[id][to] += value;
        emit TransferSingle(msg.sender, from, to, id, value);
    }

    function _burn(address from, uint256 id, uint256 value) internal {
        require(value > 0, "quantityKg must be greater than zero");
        require(balanceOf[id][from] >= value, "insufficient credits in batch");
        balanceOf[id][from] -= value;
        emit TransferSingle(msg.sender, from, address(0), id, value);
    }

    function _req(string calldata s, string memory field, uint256 max) internal pure {
        uint256 n = bytes(s).length;
        require(n > 0 && n <= max, string.concat(field, " is required"));
    }
}
