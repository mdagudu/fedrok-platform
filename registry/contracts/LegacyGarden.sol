// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IGardenGov {
    function admin() external view returns (address);
}

interface IGardenStable {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title Personal Legacy Garden: memorial tree registry
/// @notice Gardens, accredited stewards, planting batches, dedications (the
///         subscriber's non-transferable certificate) and trees with their
///         planting, monitoring and replacement history.
///
///         Names without display consent, contact details, photos and signed
///         agreements stay off-chain: only a fingerprint (bytes32) is stored.
///         Subscribers never need FDK: the Garden signs records and pays the
///         network fee. Payments are GBP off-chain (reference recorded once)
///         or the settlement stablecoin paid straight to the operator.
///         Dedications cannot be transferred or traded.
///
///         Dates are whole days since 1970-01-01 (UTC). GPS positions are
///         degrees x 1e7.
contract LegacyGarden {
    uint8 public constant PACKAGES = 5;   // standard, family, memorial, legacy, corporate
    uint8 public constant PURPOSES = 6;   // self, family, friendship, memorial, institutional, pet
    uint8 public constant METHOD_CARD = 0;
    uint8 public constant METHOD_BANK = 1;
    uint8 public constant METHOD_STABLECOIN = 2;
    uint8 public constant HEALTH_DEAD = 3;

    enum BatchStatus { Open, Released, CarriedOver, Planted }
    enum DedicationStatus { AwaitingBatch, ReadyToPlant, Planted }

    struct GardenInput {
        string code;
        string name;
        string location;
        string country;
        address operator;
        string operatorName;
        uint32 capacity;
        uint32 batchSize;
        string compartments; // distinct capital letters, e.g. "ABCD"
        int32 centreLat;
        int32 centreLon;
        uint256 priceGBP;       // pence
        uint256 maintenanceGBP; // pence per year
        uint256 stablePrice;    // stablecoin base units, 0 = not accepted
        uint16 replacementMonths;
        uint16 lifespanYears;
        bytes32 agreementHash;
        string window;          // first planting window
    }

    struct DedicationInput {
        string gardenCode;
        address holder;
        uint8 pkg;
        uint8 purpose;
        bool publicName;
        string dedicatedTo;
        string descriptor;
        bytes32 nameHash;
        string inscription;
        string preferredSpecies;
        bytes32 detailsHash;
        bytes32 agreementHash;
        string paymentRef;
        uint8 paymentMethod;
        uint256 paymentAmount; // pence
        uint32 paidOn;         // day, 0 = not given
    }

    struct PlantInput {
        uint256 dedicationId;
        string treeId;
        string species;
        string scientific;
        int32 lat;
        int32 lon;
        uint32 plantedOn;
        string seedSource;
        bytes32 photoHash;
    }

    struct MonitorInput {
        string treeId;
        uint32 date;
        uint32 heightCm;
        uint32 stemMm;
        uint8 crown;  // good, fair, poor
        uint8 health; // healthy, stressed, diseased, dead
        bytes32 photoHash;
        string note;
        string cause;
    }

    struct ReplaceInput {
        string treeId;
        uint32 plantedOn;
        int32 lat;
        int32 lon;
        string seedSource;
        bytes32 photoHash;
        string coveredBy;
        string species;
        string scientific;
    }

    struct Garden {
        string code;
        address operator;
        uint32 capacity;
        uint32 batchSize;
        bytes compartments;
        uint256 maintenanceGBP;
        uint256 stablePrice;
        uint16 replacementMonths;
        uint32 dedicationCount;
        uint32 batchCount;
        uint256 openBatch;
    }

    struct Batch {
        bytes32 gardenKey;
        uint32 n;
        string window;
        uint32 size;
        BatchStatus status;
        uint256[] dedications;
        uint32 plantedCount;
        uint256 carriedFrom;
        uint256 carriedTo;
    }

    struct Dedication {
        bytes32 gardenKey;
        address holder;
        uint256 batchId;
        bytes32 treeKey;
        DedicationStatus status;
        uint32 carryOvers;
    }

    struct Tree {
        string id;
        bytes32 gardenKey;
        uint256 dedicationId;
        bool alive;
        uint32 plantings;
        uint32 firstPlanted;
        uint32 lastPlanted;
        uint32 lastDied;
    }

    IGardenGov public immutable governance;
    IGardenStable public immutable stable;

    mapping(bytes32 => Garden) internal _gardens;
    bytes32[] public gardenKeys;
    mapping(bytes32 => mapping(address => bool)) public isStewardOf;
    mapping(uint256 => Batch) internal _batches;
    uint256 public batchCount;
    mapping(uint256 => Dedication) public dedications;
    uint256 public dedicationCount;
    mapping(uint256 => mapping(uint16 => bool)) public maintenancePaid;
    mapping(bytes32 => Tree) internal _trees;
    mapping(bytes32 => bool) public paymentRefUsed;

    event GardenRegistered(bytes32 indexed gardenKey, string code, address indexed operator, uint256 openBatch);
    event StewardSet(bytes32 indexed gardenKey, address indexed steward, string name, bool active);
    event BatchOpened(bytes32 indexed gardenKey, uint256 indexed batchId, uint32 n, string window, uint256 carriedFrom);
    event DedicationCreated(uint256 indexed dedicationId, bytes32 indexed gardenKey, address indexed holder, uint256 batchId, uint8 method, uint256 amount);
    event BatchReleased(uint256 indexed batchId, uint256 nextBatch);
    event PlantingWindowClosed(bytes32 indexed gardenKey, uint256 fromBatch, uint256 toBatch, string nextWindow, uint256 carriedOver);
    event TreePlanted(bytes32 indexed treeKey, string treeId, uint256 indexed dedicationId);
    event BatchPlanted(uint256 indexed batchId);
    event TreeMonitored(bytes32 indexed treeKey, uint32 date, bool died);
    event TreeReplaced(bytes32 indexed treeKey, uint32 planting, bool underGuarantee, string coveredBy);
    event MaintenanceRenewed(uint256 indexed dedicationId, uint16 year, string paymentRef);

    constructor(address governance_, address stable_) {
        governance = IGardenGov(governance_);
        stable = IGardenStable(stable_);
    }

    // ------------------------------------------------------------------ views
    function garden(string calldata code) external view returns (Garden memory) {
        return _gardens[keccak256(bytes(code))];
    }

    function batch(uint256 id) external view returns (Batch memory) {
        return _batches[id];
    }

    function tree(string calldata treeId) external view returns (Tree memory) {
        return _trees[keccak256(bytes(treeId))];
    }

    function isSteward(bytes32 key, address a) public view returns (bool) {
        return a == _gardens[key].operator || isStewardOf[key][a];
    }

    // ------------------------------------------------------------ gardens
    function registerGarden(GardenInput calldata p) external {
        require(msg.sender == governance.admin(), "governance only");
        bytes memory c = bytes(p.code);
        require(c.length >= 2 && c.length <= 6, "code must be 2-6 letters");
        for (uint256 i = 0; i < c.length; i++) require(c[i] >= "A" && c[i] <= "Z", "code must be 2-6 letters");
        bytes32 key = keccak256(c);
        require(_gardens[key].operator == address(0), "garden code already registered");
        require(p.operator != address(0), "operator must be a 0x address");
        bytes memory comp = bytes(p.compartments);
        require(comp.length >= 1 && comp.length <= 26, "compartments must be distinct single letters");
        for (uint256 i = 0; i < comp.length; i++) {
            require(comp[i] >= "A" && comp[i] <= "Z", "compartments must be distinct single letters");
            for (uint256 j = 0; j < i; j++) require(comp[i] != comp[j], "compartments must be distinct single letters");
        }
        _text(p.name, "name", 160);
        _text(p.location, "location", 160);
        _text(p.country, "country", 80);
        _text(p.window, "window", 120);
        require(bytes(p.operatorName).length <= 120, "operatorName too long");
        require(p.capacity >= 1 && p.capacity <= 100_000, "capacity must be a whole number from 1 to 100000");
        require(p.batchSize >= 1 && p.batchSize <= 1000, "batchSize must be a whole number from 1 to 1000");
        require(p.priceGBP > 0 && p.maintenanceGBP > 0, "prices must be positive amounts in pence");
        require(p.replacementMonths <= 120, "replacementMonths must be 0-120");
        require(p.lifespanYears >= 1 && p.lifespanYears <= 200, "lifespanYears must be 1-200");
        _gps(p.centreLat, p.centreLon);
        Garden storage g = _gardens[key];
        g.code = p.code;
        g.operator = p.operator;
        g.capacity = p.capacity;
        g.batchSize = p.batchSize;
        g.compartments = comp;
        g.maintenanceGBP = p.maintenanceGBP;
        g.stablePrice = p.stablePrice;
        g.replacementMonths = p.replacementMonths;
        gardenKeys.push(key);
        uint256 b = _newBatch(key, p.window, 0);
        emit GardenRegistered(key, p.code, p.operator, b);
    }

    function setSteward(string calldata code, address steward, string calldata name, bool active) external {
        bytes32 key = _gardenKey(code);
        require(msg.sender == _gardens[key].operator, "only the Garden operator can manage stewards");
        require(steward != address(0), "steward must be a 0x address");
        if (active) _text(name, "name", 120);
        isStewardOf[key][steward] = active;
        emit StewardSet(key, steward, name, active);
    }

    // ------------------------------------------------------------ dedications
    function createDedication(DedicationInput calldata p) external returns (uint256 id) {
        bytes32 key = _gardenKey(p.gardenCode);
        Garden storage g = _gardens[key];
        require(p.pkg < PACKAGES, "unknown package");
        require(p.purpose < PURPOSES, "unknown purpose");
        if (p.publicName) {
            _text(p.dedicatedTo, "dedicatedTo", 120);
            require(bytes(p.descriptor).length <= 80 && bytes(p.inscription).length <= 200, "text field too long");
        } else {
            require(bytes(p.dedicatedTo).length == 0 && bytes(p.inscription).length == 0, "do not put a name on-chain without consent: send nameHash instead");
            require(p.nameHash != bytes32(0), "nameHash must be a 0x-prefixed 32-byte hex fingerprint");
        }
        require(bytes(p.preferredSpecies).length <= 80, "preferredSpecies too long");
        require(g.dedicationCount < g.capacity, "the Garden is fully subscribed");

        address holder;
        uint8 method;
        uint256 amount;
        if (isSteward(key, msg.sender)) {
            // Back office: GBP taken by card or bank transfer, reference recorded once.
            holder = p.holder;
            require(holder != address(0), "holder must be the member account address");
            _text(p.paymentRef, "payment.ref", 80);
            bytes32 ref = keccak256(bytes(p.paymentRef));
            require(!paymentRefUsed[ref], "payment reference already recorded");
            require(p.paymentMethod <= METHOD_BANK, "payment.method must be card or bank transfer");
            require(p.paymentAmount > 0, "payment.amount must be a positive integer in minor units");
            if (p.paidOn != 0) _pastDay(p.paidOn, "payment.paidOn");
            paymentRefUsed[ref] = true;
            method = p.paymentMethod;
            amount = p.paymentAmount;
        } else {
            // Self-service: the member pays the stablecoin price to the operator.
            require(g.stablePrice > 0, "this Garden does not accept stablecoin payments");
            holder = msg.sender;
            method = METHOD_STABLECOIN;
            amount = g.stablePrice;
            require(stable.transferFrom(msg.sender, g.operator, g.stablePrice), "stablecoin payment failed");
        }

        id = ++dedicationCount;
        g.dedicationCount += 1;
        Batch storage b = _batches[g.openBatch];
        dedications[id] = Dedication(key, holder, g.openBatch, bytes32(0), DedicationStatus.AwaitingBatch, 0);
        b.dedications.push(id);
        emit DedicationCreated(id, key, holder, g.openBatch, method, amount);
        if (b.dedications.length >= b.size) {
            b.status = BatchStatus.Released;
            for (uint256 i = 0; i < b.dedications.length; i++) dedications[b.dedications[i]].status = DedicationStatus.ReadyToPlant;
            uint256 releasedId = g.openBatch;
            uint256 next = _newBatch(key, b.window, 0);
            emit BatchReleased(releasedId, next);
        }
    }

    /// @notice End of a planting window: an unfilled batch is not planted;
    ///         its paid subscriptions carry over to the next window.
    function closePlantingWindow(string calldata code, string calldata nextWindow) external {
        bytes32 key = _gardenKey(code);
        _steward(key);
        _text(nextWindow, "nextWindow", 120);
        _closeWindow(key, nextWindow);
    }

    function _closeWindow(bytes32 key, string memory nextWindow) internal {
        uint256 fromId = _gardens[key].openBatch;
        Batch storage b = _batches[fromId];
        if (b.dedications.length == 0) {
            b.window = nextWindow;
            emit PlantingWindowClosed(key, fromId, fromId, nextWindow, 0);
            return;
        }
        b.status = BatchStatus.CarriedOver;
        uint256 toId = _newBatch(key, nextWindow, fromId);
        b.carriedTo = toId;
        _moveDedications(fromId, toId);
        emit PlantingWindowClosed(key, fromId, toId, nextWindow, b.dedications.length);
    }

    function _moveDedications(uint256 fromId, uint256 toId) internal {
        uint256[] storage from = _batches[fromId].dedications;
        uint256[] storage to = _batches[toId].dedications;
        for (uint256 i = 0; i < from.length; i++) {
            uint256 d = from[i];
            to.push(d);
            dedications[d].batchId = toId;
            dedications[d].carryOvers += 1;
        }
    }

    // ------------------------------------------------------------ trees
    function plantTree(PlantInput calldata p) external {
        Dedication storage d = dedications[p.dedicationId];
        require(d.holder != address(0), "unknown dedication");
        _steward(d.gardenKey);
        require(d.treeKey == bytes32(0), "this dedication already has a tree");
        Batch storage b = _batches[d.batchId];
        require(b.status == BatchStatus.Released, "the batch has not been released for planting");
        Garden storage g = _gardens[d.gardenKey];
        _checkTreeId(p.treeId, g, p.plantedOn);
        bytes32 tk = keccak256(bytes(p.treeId));
        require(_trees[tk].plantings == 0, "tree ID already in use");
        _pastDay(p.plantedOn, "plantedOn");
        _gps(p.lat, p.lon);
        _text(p.species, "species", 80);
        _text(p.scientific, "scientific", 120);
        _text(p.seedSource, "seedSource", 160);
        require(p.photoHash != bytes32(0), "photoHash must be a 0x-prefixed 32-byte hex fingerprint");
        _trees[tk] = Tree(p.treeId, d.gardenKey, p.dedicationId, true, 1, p.plantedOn, p.plantedOn, 0);
        d.treeKey = tk;
        d.status = DedicationStatus.Planted;
        b.plantedCount += 1;
        emit TreePlanted(tk, p.treeId, p.dedicationId);
        if (b.plantedCount == b.dedications.length) {
            b.status = BatchStatus.Planted;
            emit BatchPlanted(d.batchId);
        }
    }

    function monitorTree(MonitorInput calldata p) external {
        bytes32 tk = keccak256(bytes(p.treeId));
        Tree storage t = _trees[tk];
        require(t.plantings > 0, "unknown tree");
        _steward(t.gardenKey);
        require(t.alive, "this tree is recorded as dead: record a replacement first");
        _pastDay(p.date, "date");
        require(p.date >= t.lastPlanted, "inspection date is before the planting date");
        require(p.health <= HEALTH_DEAD, "unknown health");
        require(p.crown <= 2, "unknown crown");
        require(p.heightCm <= 10_000 && p.stemMm <= 5_000, "measurement out of range");
        require(bytes(p.note).length <= 300, "note too long");
        bool died = p.health == HEALTH_DEAD;
        if (died) {
            _text(p.cause, "cause", 160);
            t.alive = false;
            t.lastDied = p.date;
        }
        emit TreeMonitored(tk, p.date, died);
    }

    /// @notice A dead tree keeps its Tree ID and dedication; the replacement
    ///         gets a new planting date and GPS position.
    function replaceTree(ReplaceInput calldata p) external {
        bytes32 tk = keccak256(bytes(p.treeId));
        Tree storage t = _trees[tk];
        require(t.plantings > 0, "unknown tree");
        _steward(t.gardenKey);
        require(!t.alive, "only a tree recorded as dead can be replaced");
        _pastDay(p.plantedOn, "plantedOn");
        require(p.plantedOn >= t.lastDied, "replacement cannot be planted before the tree died");
        _gps(p.lat, p.lon);
        _text(p.seedSource, "seedSource", 160);
        require(p.photoHash != bytes32(0), "photoHash must be a 0x-prefixed 32-byte hex fingerprint");
        require(bytes(p.species).length <= 80 && bytes(p.scientific).length <= 120, "text field too long");
        Garden storage g = _gardens[t.gardenKey];
        // months since first planting = days / 30.4375
        bool underGuarantee = uint256(t.lastDied - t.firstPlanted) * 10000 <= uint256(g.replacementMonths) * 304375;
        string memory coveredBy;
        if (underGuarantee) {
            coveredBy = "";
        } else {
            _text(p.coveredBy, "coveredBy (guarantee period has ended)", 120);
            coveredBy = p.coveredBy;
        }
        t.plantings += 1;
        t.alive = true;
        t.lastPlanted = p.plantedOn;
        emit TreeReplaced(tk, t.plantings, underGuarantee, coveredBy);
    }

    function renewMaintenance(uint256 dedicationId, uint16 year, string calldata paymentRef) external {
        Dedication storage d = dedications[dedicationId];
        require(d.holder != address(0), "unknown dedication");
        _steward(d.gardenKey);
        require(year >= 2000 && year <= 2200, "year must be a whole number from 2000 to 2200");
        require(!maintenancePaid[dedicationId][year], "maintenance for this year is already recorded");
        _text(paymentRef, "paymentRef", 80);
        bytes32 ref = keccak256(bytes(paymentRef));
        require(!paymentRefUsed[ref], "payment reference already recorded");
        paymentRefUsed[ref] = true;
        maintenancePaid[dedicationId][year] = true;
        emit MaintenanceRenewed(dedicationId, year, paymentRef);
    }

    // ------------------------------------------------------------ internals
    function _newBatch(bytes32 key, string memory window, uint256 carriedFrom) internal returns (uint256 id) {
        Garden storage g = _gardens[key];
        id = ++batchCount;
        g.batchCount += 1;
        Batch storage b = _batches[id];
        b.gardenKey = key;
        b.n = g.batchCount;
        b.window = window;
        b.size = g.batchSize;
        b.carriedFrom = carriedFrom;
        g.openBatch = id;
        emit BatchOpened(key, id, b.n, window, carriedFrom);
    }

    function _gardenKey(string calldata code) internal view returns (bytes32 key) {
        key = keccak256(bytes(code));
        require(_gardens[key].operator != address(0), string.concat("unknown garden ", code));
    }

    function _steward(bytes32 key) internal view {
        require(isSteward(key, msg.sender), "only the Garden operator or an accredited steward can record this");
    }

    function _text(string calldata s, string memory field, uint256 max) internal pure {
        uint256 n = bytes(s).length;
        require(n > 0 && n <= max, string.concat(field, " is required"));
    }

    function _gps(int32 lat, int32 lon) internal pure {
        require(lat >= -900000000 && lat <= 900000000, "gps.lat out of range");
        require(lon >= -1800000000 && lon <= 1800000000, "gps.lon out of range");
    }

    function _pastDay(uint32 day, string memory field) internal view {
        require(day > 0, string.concat(field, " must be a date"));
        require(uint256(day) <= block.timestamp / 1 days + 1, string.concat(field, " cannot be in the future"));
    }

    /// @dev Tree IDs look like BITG-2026-A-001: garden code, planting year,
    ///      compartment letter and a three-digit number.
    function _checkTreeId(string calldata treeId, Garden storage g, uint32 plantedOn) internal view {
        bytes memory t = bytes(treeId);
        bytes memory code = bytes(g.code);
        uint256 n = code.length;
        bool ok = t.length == n + 11 && t[n] == "-" && t[n + 5] == "-" && t[n + 7] == "-";
        for (uint256 i = 0; ok && i < n; i++) ok = t[i] == code[i];
        uint256 year;
        for (uint256 i = n + 1; ok && i < n + 5; i++) {
            ok = t[i] >= "0" && t[i] <= "9";
            year = year * 10 + (uint8(t[i]) - 48);
        }
        for (uint256 i = n + 8; ok && i < n + 11; i++) ok = t[i] >= "0" && t[i] <= "9";
        require(ok, string.concat("treeId must look like ", g.code, "-2027-A-001"));
        bool known;
        for (uint256 i = 0; i < g.compartments.length; i++) if (g.compartments[i] == t[n + 6]) known = true;
        require(known, "compartment does not exist in this Garden");
        require(year == _yearOf(plantedOn), "the year in the tree ID must match the planting year");
    }

    function _yearOf(uint32 day) internal pure returns (uint256) {
        uint256 z = uint256(day) + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        return mp >= 10 ? y + 1 : y;
    }
}
