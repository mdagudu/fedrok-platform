// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IRegistryGov {
    function admin() external view returns (address);
}

/// @title Fedrok environmental project registry
/// @notice The ledger behind "Register your project / Propose a project".
///
///         Anyone can open a project record: either a project they run
///         (Registered) or an idea they put forward (Proposed). While the
///         record is a Draft its owner can edit it as often as they like;
///         every edit is a transaction, so the full revision history is on
///         the chain.
///
///         Lock & submit freezes the record for good. The contract stores a
///         fingerprint of the final content and from then on rejects every
///         change, whoever signs it: the owner, governance, or software
///         acting with the owner's key (such as an AI assistant). The only
///         action left is retirement, which marks the project as retired but
///         keeps its content unchanged and readable.
contract ProjectRegistry {
    enum Kind { Registered, Proposed }
    enum Status { Draft, Locked, Retired }

    struct Project {
        uint64 id;
        Kind kind;
        Status status;
        address owner;
        string projectType;
        string name;
        string summary;
        string location;
        string country;
        string details;     // JSON object of structured project details
        uint32 revision;    // number of edits since creation
        uint64 createdAt;
        uint64 updatedAt;
        uint64 lockedAt;
        uint64 retiredAt;
        bytes32 lockedHash; // fingerprint of the content at lock time
        string retireReason;
    }

    struct Content {
        string name;
        string summary;
        string location;
        string country;
        string details;
    }

    address public immutable governance;
    string[] public projectTypes;
    mapping(bytes32 => bool) public isProjectType;

    mapping(uint64 => Project) internal projects;
    uint64 public projectCount;

    event ProjectTypeAdded(string projectType);
    event ProjectCreated(uint64 indexed id, address indexed owner, Kind kind, string projectType, string name);
    event ProjectUpdated(uint64 indexed id, address indexed owner, uint32 revision, bytes32 contentHash);
    event ProjectLocked(uint64 indexed id, address indexed owner, uint32 revision, bytes32 contentHash);
    event ProjectRetired(uint64 indexed id, address indexed owner, bool wasLocked, string reason);

    constructor(address governance_, string[] memory types_) {
        governance = governance_;
        for (uint256 i = 0; i < types_.length; i++) _addType(types_[i]);
    }

    // ------------------------------------------------------------ project types
    function _addType(string memory t) internal {
        require(bytes(t).length > 0 && bytes(t).length <= 80, "project type is required (max 80 chars)");
        bytes32 k = keccak256(bytes(t));
        require(!isProjectType[k], "project type already listed");
        isProjectType[k] = true;
        projectTypes.push(t);
        emit ProjectTypeAdded(t);
    }

    function addProjectType(string calldata t) external {
        require(msg.sender == IRegistryGov(governance).admin(), "governance only");
        _addType(t);
    }

    function projectTypeList() external view returns (string[] memory) {
        return projectTypes;
    }

    // ------------------------------------------------------------ projects
    function _checkContent(Content memory c) internal pure {
        require(bytes(c.name).length >= 3 && bytes(c.name).length <= 120, "project name must be 3-120 characters");
        require(bytes(c.summary).length <= 1000, "summary is too long (max 1000 characters)");
        require(bytes(c.location).length <= 160, "location is too long (max 160 characters)");
        require(bytes(c.country).length <= 80, "country is too long (max 80 characters)");
        require(bytes(c.details).length <= 20000, "details are too long (max 20000 bytes)");
    }

    function contentHash(Content memory c) public pure returns (bytes32) {
        return keccak256(abi.encode(c.name, c.summary, c.location, c.country, c.details));
    }

    function _hashOf(Project storage p) internal view returns (bytes32) {
        return contentHash(Content(p.name, p.summary, p.location, p.country, p.details));
    }

    function _own(uint64 id) internal view returns (Project storage p) {
        p = projects[id];
        require(p.id != 0, "unknown project");
        require(msg.sender == p.owner, "only the project owner can do this");
    }

    function createProject(Kind kind, string calldata projectType, Content calldata c) external returns (uint64 id) {
        require(isProjectType[keccak256(bytes(projectType))], "choose a listed environmental project type");
        _checkContent(c);
        id = ++projectCount;
        Project storage p = projects[id];
        p.id = id;
        p.kind = kind;
        p.status = Status.Draft;
        p.owner = msg.sender;
        p.projectType = projectType;
        p.name = c.name;
        p.summary = c.summary;
        p.location = c.location;
        p.country = c.country;
        p.details = c.details;
        p.createdAt = uint64(block.timestamp);
        p.updatedAt = uint64(block.timestamp);
        emit ProjectCreated(id, msg.sender, kind, projectType, c.name);
    }

    /// @notice Replace the editable content of a Draft project.
    function updateProject(uint64 id, Content calldata c) external {
        Project storage p = _own(id);
        require(p.status == Status.Draft, "project is locked and submitted: it can no longer be changed");
        _checkContent(c);
        p.name = c.name;
        p.summary = c.summary;
        p.location = c.location;
        p.country = c.country;
        p.details = c.details;
        p.revision += 1;
        p.updatedAt = uint64(block.timestamp);
        emit ProjectUpdated(id, msg.sender, p.revision, _hashOf(p));
    }

    /// @notice Freeze the project permanently. `expectedHash` must match the
    ///         current content, so the owner locks exactly what they reviewed.
    function lockAndSubmit(uint64 id, bytes32 expectedHash) external {
        Project storage p = _own(id);
        require(p.status == Status.Draft, "project is already locked and submitted");
        require(bytes(p.summary).length > 0, "add a summary before locking the project");
        require(bytes(p.details).length > 2, "add the project details before locking the project");
        bytes32 h = _hashOf(p);
        require(expectedHash == h, "the project changed since you reviewed it: review it again before locking");
        p.status = Status.Locked;
        p.lockedHash = h;
        p.lockedAt = uint64(block.timestamp);
        emit ProjectLocked(id, msg.sender, p.revision, h);
    }

    /// @notice Retire a project (Draft or Locked). Content stays as it is.
    function retire(uint64 id, string calldata reason) external {
        Project storage p = _own(id);
        require(p.status != Status.Retired, "project is already retired");
        require(bytes(reason).length > 0 && bytes(reason).length <= 300, "a retirement reason is required (max 300 characters)");
        bool wasLocked = p.status == Status.Locked;
        p.status = Status.Retired;
        p.retiredAt = uint64(block.timestamp);
        p.retireReason = reason;
        emit ProjectRetired(id, msg.sender, wasLocked, reason);
    }

    function project(uint64 id) external view returns (Project memory) {
        require(projects[id].id != 0, "unknown project");
        return projects[id];
    }
}
