// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IPogGov {
    function admin() external view returns (address);
    function isAuditor(address a) external view returns (bool);
    function fallbackValidator() external view returns (address);
    function blockTimeMs() external view returns (uint256);
    function minGeneratorStake() external view returns (uint256);
    function fdkPerUnitYear() external view returns (uint256);
    function greenWindow() external view returns (uint256);
    function maxGeneratorsPerMiner() external view returns (uint256);
}

interface IPogIssuer {
    function issue(address to, uint256 amount, string calldata reason) external;
    function burn(string calldata reason) external payable;
}

/// @title Proof of Green consensus system contract
/// @notice Holds everything the Proof of Green engine needs: accredited green
///         Bitcoin miners, staked block generators, the Bitcoin anchor and the
///         Piggy Bank. The node calls `onBlock` from the system address at the
///         start of every block (like EIP-4788 system calls). That call fails,
///         and so the block is invalid, unless the block's generator holds
///         the current slot in the schedule this contract computes.
///
///         Piggy Bank FDK pays for block production work (operating green
///         miners and running generators). It is a protocol fee for a service,
///         not a return on holding FDK: holders earn nothing for holding.
contract ProofOfGreen {
    address public constant SYSTEM = 0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE;
    uint256 public constant YEAR = 365 days;

    struct Miner {
        bytes4 id;
        string name;
        string btcAddress;
        address owner;
        uint32 units;
        address auditor;
        string site;
        string energy;
        string reportRef;
        uint64 accreditedAt;
        uint64 expiresAt;
        bool active;
        uint256 yearlyReward;
        uint256 prefill;
        bool publicGenerators;
        uint16 generatorShareBps;
        uint64 greenBlocks;
        uint256 rewardsEarned;
        string revokedReason;
        address[] generators;
    }

    struct Generator {
        uint256 stake;
        string name;
        uint64 registeredAt;
        uint64 blocks;
        bool exists;
        bytes4[] links;
    }

    struct AccreditInput {
        address owner;
        bytes btcPubKey;   // 64-byte uncompressed secp256k1 key (no 0x04 prefix)
        bytes32 sigR;
        bytes32 sigS;
        uint8 sigV;
        uint32 units;      // S9-equivalent units
        uint16 auditDays;
        uint16 generatorShareBps;
        bool publicGenerators;
        string name;
        string site;
        string energy;
        string reportRef;
    }

    struct PogState {
        uint64 anchorHeight;
        bytes32 anchorHash;
        bytes4 activeMiner;
        int64 lastGreenBtcHeight;
        uint64 greenBlocksSeen;
        uint256 piggyBank;
        uint256 yearlyEmission;
        uint256 totalRewards;
        uint64 lastBlockTime;
    }

    IPogGov public immutable governance;
    IPogIssuer public immutable fdkIssuer;

    mapping(bytes4 => Miner) internal _miners;
    bytes4[] public minerIds;
    mapping(bytes4 => mapping(address => bool)) public approved;
    mapping(bytes32 => bytes4) public btcToMiner;
    mapping(address => Generator) internal _generators;
    address[] public generatorList;

    uint256 public piggyBank;
    uint256 public yearlyEmission;
    uint256 public totalRewards;
    uint64 public anchorHeight;
    bytes32 public anchorHash;
    bytes4 public activeMiner;
    int64 public lastGreenBtcHeight = -1;
    uint64 public greenBlocksSeen;
    uint64 public lastBlockTime;
    uint256 public lastSlot;

    event MinerAccredited(bytes4 indexed minerId, string btcAddress, address indexed owner, address indexed auditor, uint32 units, uint256 piggyBankPrefill);
    event MinerRevoked(bytes4 indexed minerId, string reason, uint256 unservedBurned);
    event MinerExpired(bytes4 indexed minerId);
    event MinerUpdated(bytes4 indexed minerId, bool publicGenerators, uint16 generatorShareBps);
    event GeneratorRegistered(address indexed generator, uint256 stake, string name);
    event GeneratorApproved(bytes4 indexed minerId, address indexed generator);
    event GeneratorLinked(bytes4 indexed minerId, address indexed generator);
    event GeneratorUnlinked(bytes4 indexed minerId, address indexed generator);
    event GeneratorExited(address indexed generator, uint256 returnedStake);
    event GreenBitcoinBlock(bytes4 indexed minerId, uint64 btcHeight);
    event BlockProduced(address indexed generator, bool green, bytes4 minerId, uint256 reward, uint256 minerReward, uint256 generatorReward, uint64 btcAnchorHeight, bytes32 btcAnchorHash);

    constructor(address governance_, address issuer_, uint64 anchorHeight_, bytes32 anchorHash_, uint64 genesisTime_) {
        governance = IPogGov(governance_);
        fdkIssuer = IPogIssuer(issuer_);
        anchorHeight = anchorHeight_;
        anchorHash = anchorHash_;
        lastBlockTime = genesisTime_;
    }

    receive() external payable {
        require(msg.sender == address(fdkIssuer), "send FDK through register()");
    }

    // ------------------------------------------------------------------ views
    function miner(bytes4 id) external view returns (Miner memory) {
        return _miners[id];
    }

    function generator(address g) external view returns (Generator memory) {
        return _generators[g];
    }

    function minerCount() external view returns (uint256) {
        return minerIds.length;
    }

    function generatorCount() external view returns (uint256) {
        return generatorList.length;
    }

    function state() external view returns (PogState memory) {
        return PogState(anchorHeight, anchorHash, activeMiner, lastGreenBtcHeight, greenBlocksSeen, piggyBank, yearlyEmission, totalRewards, lastBlockTime);
    }

    /// @notice The current production schedule: the active green miner's
    ///         generators, or the fallback validator.
    function schedule() public view returns (bool green, bytes4 minerId, address[] memory gens) {
        Miner storage m = _miners[activeMiner];
        bool fresh = lastGreenBtcHeight >= 0 && int256(uint256(anchorHeight)) - int256(lastGreenBtcHeight) < int256(governance.greenWindow());
        if (activeMiner != bytes4(0) && m.active && fresh && m.generators.length > 0) {
            return (true, activeMiner, m.generators);
        }
        gens = new address[](1);
        gens[0] = governance.fallbackValidator();
        return (false, bytes4(0), gens);
    }

    function slotOf(uint256 timestamp) public view returns (uint256) {
        return (timestamp * 1000) / governance.blockTimeMs();
    }

    function leaderAt(uint256 slot) public view returns (address) {
        (, , address[] memory gens) = schedule();
        return gens[slot % gens.length];
    }

    function btcLinkDigest(bytes20 btcHash160, address owner) public view returns (bytes32) {
        return keccak256(abi.encode("Fedrok green miner link", block.chainid, address(this), btcHash160, owner));
    }

    /// @notice Devnet Bitcoin address of a key: "bcsim1" + hex(hash160(compressed key)).
    function btcAddressOf(bytes memory pub64) public pure returns (string memory addr, bytes20 h160) {
        require(pub64.length == 64, "btcPubKey must be 64 bytes");
        bytes memory compressed = new bytes(33);
        compressed[0] = (uint8(pub64[63]) & 1) == 1 ? bytes1(0x03) : bytes1(0x02);
        for (uint256 i = 0; i < 32; i++) compressed[i + 1] = pub64[i];
        h160 = ripemd160(abi.encodePacked(sha256(compressed)));
        addr = string.concat("bcsim1", _hex(h160));
    }

    // ------------------------------------------------------------ accreditation
    function accredit(AccreditInput calldata p) external returns (bytes4 id) {
        require(governance.isAuditor(msg.sender), "only an accredited auditor can accredit miners");
        require(p.owner != address(0), "owner must be a 0x address");
        (string memory btcAddress, bytes20 h160) = btcAddressOf(p.btcPubKey);
        address keyAddr = address(uint160(uint256(keccak256(p.btcPubKey))));
        address signer = ecrecover(btcLinkDigest(h160, p.owner), p.sigV, p.sigR, p.sigS);
        require(signer != address(0) && signer == keyAddr, "Bitcoin ownership proof is invalid");
        require(p.units >= 1 && p.units <= 1_000_000, "units must be a whole number of S9-equivalents");
        require(p.auditDays >= 1 && p.auditDays <= 730, "auditDays must be 1-730");
        require(p.generatorShareBps <= 10000, "generatorShareBps must be 0-10000");
        require(bytes(p.name).length <= 120 && bytes(p.site).length <= 160 && bytes(p.energy).length <= 120 && bytes(p.reportRef).length <= 200, "text field too long");
        id = bytes4(keccak256(bytes(btcAddress)));
        Miner storage m = _miners[id];
        require(!m.active, "miner already accredited");
        if (m.id == bytes4(0)) {
            minerIds.push(id);
            m.id = id;
        }
        uint256 yearly = uint256(p.units) * governance.fdkPerUnitYear();
        uint256 prefill = (yearly * p.auditDays) / 365;
        m.name = bytes(p.name).length > 0 ? p.name : btcAddress;
        m.btcAddress = btcAddress;
        m.owner = p.owner;
        m.units = p.units;
        m.auditor = msg.sender;
        m.site = p.site;
        m.energy = p.energy;
        m.reportRef = p.reportRef;
        m.accreditedAt = uint64(block.timestamp);
        m.expiresAt = uint64(block.timestamp + uint256(p.auditDays) * 1 days);
        m.active = true;
        m.yearlyReward = yearly;
        m.prefill = prefill;
        m.publicGenerators = p.publicGenerators;
        m.generatorShareBps = p.generatorShareBps;
        m.revokedReason = "";
        btcToMiner[keccak256(bytes(btcAddress))] = id;
        yearlyEmission += yearly;
        piggyBank += prefill;
        fdkIssuer.issue(address(this), prefill, "Piggy Bank pre-fill");
        emit MinerAccredited(id, btcAddress, p.owner, msg.sender, p.units, prefill);
    }

    function revoke(bytes4 id, string calldata reason) external {
        Miner storage m = _miners[id];
        require(m.active, "miner is not active");
        require(msg.sender == governance.admin() || msg.sender == m.auditor, "only the accrediting auditor or governance can revoke");
        require(bytes(reason).length > 0 && bytes(reason).length <= 300, "reason is required (max 300 chars)");
        uint256 remaining = m.expiresAt > block.timestamp ? m.expiresAt - block.timestamp : 0;
        uint256 unserved = (m.yearlyReward * remaining) / YEAR;
        uint256 burned = unserved > piggyBank ? piggyBank : unserved;
        piggyBank -= burned;
        m.active = false;
        m.revokedReason = reason;
        yearlyEmission -= m.yearlyReward;
        if (burned > 0) fdkIssuer.burn{value: burned}("unserved Piggy Bank reward");
        emit MinerRevoked(id, reason, burned);
    }

    function updateMiner(bytes4 id, bool setPublic, bool publicGenerators, bool setShare, uint16 generatorShareBps) external {
        Miner storage m = _miners[id];
        require(m.id != bytes4(0), "unknown miner");
        require(m.owner == msg.sender, "only the miner owner can update");
        if (setPublic) m.publicGenerators = publicGenerators;
        if (setShare) {
            require(generatorShareBps <= 10000, "generatorShareBps must be 0-10000");
            m.generatorShareBps = generatorShareBps;
        }
        emit MinerUpdated(id, m.publicGenerators, m.generatorShareBps);
    }

    // ------------------------------------------------------------ generators
    function registerGenerator(string calldata name) external payable {
        Generator storage g = _generators[msg.sender];
        require(!g.exists, "already registered as block generator");
        require(msg.value >= governance.minGeneratorStake(), "stake must be at least the minimum generator stake");
        require(bytes(name).length <= 80, "name too long");
        g.exists = true;
        g.stake = msg.value;
        g.name = name;
        g.registeredAt = uint64(block.timestamp);
        generatorList.push(msg.sender);
        emit GeneratorRegistered(msg.sender, msg.value, name);
    }

    function approveGenerator(bytes4 id, address gen) external {
        Miner storage m = _miners[id];
        require(m.id != bytes4(0), "unknown miner");
        require(m.owner == msg.sender, "only the miner owner can approve generators");
        require(gen != address(0), "generator must be a 0x address");
        approved[id][gen] = true;
        emit GeneratorApproved(id, gen);
    }

    function link(bytes4 id) external {
        Generator storage g = _generators[msg.sender];
        require(g.exists, "register as a block generator first");
        Miner storage m = _miners[id];
        require(m.active, "miner is not active");
        require(m.publicGenerators || approved[id][msg.sender] || m.owner == msg.sender, "miner is private and has not approved you");
        for (uint256 i = 0; i < m.generators.length; i++) require(m.generators[i] != msg.sender, "already linked");
        require(m.generators.length < governance.maxGeneratorsPerMiner(), "miner has the maximum number of generators");
        m.generators.push(msg.sender);
        g.links.push(id);
        emit GeneratorLinked(id, msg.sender);
    }

    function unlink(bytes4 id) external {
        Generator storage g = _generators[msg.sender];
        require(g.exists, "not a generator");
        Miner storage m = _miners[id];
        bool found;
        for (uint256 i = 0; i < m.generators.length; i++) {
            if (m.generators[i] == msg.sender) {
                for (uint256 j = i; j + 1 < m.generators.length; j++) m.generators[j] = m.generators[j + 1];
                m.generators.pop();
                found = true;
                break;
            }
        }
        require(found, "not linked to that miner");
        for (uint256 i = 0; i < g.links.length; i++) {
            if (g.links[i] == id) {
                g.links[i] = g.links[g.links.length - 1];
                g.links.pop();
                break;
            }
        }
        emit GeneratorUnlinked(id, msg.sender);
    }

    function exitGenerator() external {
        Generator storage g = _generators[msg.sender];
        require(g.exists, "not a generator");
        require(g.links.length == 0, "unlink from all miners first");
        uint256 stake = g.stake;
        delete _generators[msg.sender];
        for (uint256 i = 0; i < generatorList.length; i++) {
            if (generatorList[i] == msg.sender) {
                generatorList[i] = generatorList[generatorList.length - 1];
                generatorList.pop();
                break;
            }
        }
        (bool ok, ) = msg.sender.call{value: stake}("");
        require(ok, "stake return failed");
        emit GeneratorExited(msg.sender, stake);
    }

    // ------------------------------------------------------------ consensus
    /// @notice System call at the start of every block. `btcMiners[i]` is the
    ///         keccak of the coinbase address of Bitcoin block firstHeight+i.
    ///         Header linkage and proof of work are checked by every node's
    ///         Bitcoin light client before this call.
    function onBlock(address gen, uint64 firstHeight, bytes32[] calldata btcHashes, bytes32[] calldata btcMiners) external {
        require(msg.sender == SYSTEM, "system call only");
        require(gen == block.coinbase, "generator must be the block coinbase");
        require(btcHashes.length == btcMiners.length, "btc header arrays differ");
        uint256 slot = slotOf(block.timestamp);
        require(slot > lastSlot, "slot already used");

        if (btcHashes.length > 0) require(firstHeight == anchorHeight + 1, "btc header height gap");
        for (uint256 i = 0; i < btcHashes.length; i++) {
            uint64 h = firstHeight + uint64(i);
            bytes4 id = btcToMiner[btcMiners[i]];
            if (id != bytes4(0) && _miners[id].active && _miners[id].expiresAt > block.timestamp) {
                activeMiner = id;
                lastGreenBtcHeight = int64(h);
                greenBlocksSeen += 1;
                _miners[id].greenBlocks += 1;
                emit GreenBitcoinBlock(id, h);
            }
            anchorHeight = h;
            anchorHash = btcHashes[i];
        }

        for (uint256 i = 0; i < minerIds.length; i++) {
            Miner storage x = _miners[minerIds[i]];
            if (x.active && x.expiresAt <= block.timestamp) {
                x.active = false;
                x.revokedReason = "audit period expired";
                yearlyEmission -= x.yearlyReward;
                emit MinerExpired(x.id);
            }
        }

        (bool green, bytes4 mid, address[] memory gens) = schedule();
        require(gens[slot % gens.length] == gen, "not this generator's slot");

        uint256 reward;
        uint256 minerReward;
        uint256 generatorReward;
        if (green) {
            uint256 dt = block.timestamp - lastBlockTime;
            uint256 cap = (governance.blockTimeMs() * 10) / 1000;
            if (dt > cap) dt = cap;
            reward = (yearlyEmission * dt) / YEAR;
            if (reward > piggyBank) reward = piggyBank;
            Miner storage m = _miners[mid];
            generatorReward = (reward * m.generatorShareBps) / 10000;
            minerReward = reward - generatorReward;
            piggyBank -= reward;
            totalRewards += reward;
            m.rewardsEarned += minerReward;
            _pay(m.owner, minerReward);
            _pay(gen, generatorReward);
        }
        if (_generators[gen].exists) _generators[gen].blocks += 1;
        lastBlockTime = uint64(block.timestamp);
        lastSlot = slot;
        emit BlockProduced(gen, green, mid, reward, minerReward, generatorReward, anchorHeight, anchorHash);
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount, gas: 30000}("");
        if (!ok) piggyBank += amount; // undeliverable: stays in the Piggy Bank
    }

    function _hex(bytes20 b) internal pure returns (string memory) {
        bytes memory out = new bytes(40);
        bytes16 digits = "0123456789abcdef";
        for (uint256 i = 0; i < 20; i++) {
            out[2 * i] = digits[uint8(b[i]) >> 4];
            out[2 * i + 1] = digits[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }
}
