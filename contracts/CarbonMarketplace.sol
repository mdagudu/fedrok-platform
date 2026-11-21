// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IMarketGov {
    function admin() external view returns (address);
    function marketFeeBps() external view returns (uint256);
}

interface IMarketRegistry {
    function marketTransfer(address from, address to, uint256 id, uint256 value) external;
    function batchCount() external view returns (uint256);
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title Stablecoin-settled carbon credit marketplace
/// @notice Escrowed listings priced per tonne in the settlement stablecoin.
///         A purchase is atomic: stablecoin to the seller (less the platform
///         fee) and credits to the buyer in one transaction. FDK is never a
///         payment currency here.
contract CarbonMarketplace {
    enum Status { None, Open, Filled, Cancelled }

    struct Listing {
        address seller;
        uint256 batchId;
        uint256 listedKg;
        uint256 remainingKg;
        uint256 pricePerTonne; // stablecoin base units per 1000 kg
        Status status;
        uint64 createdAt;
    }

    IMarketGov public immutable governance;
    IMarketRegistry public immutable registry;
    IERC20 public immutable stable;
    uint256 public listingCount;
    mapping(uint256 => Listing) public listings;

    event Listed(uint256 indexed listingId, address indexed seller, uint256 indexed batchId, uint256 quantityKg, uint256 pricePerTonne);
    event Purchased(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 batchId, uint256 quantityKg, uint256 paid, uint256 platformFee);
    event ListingCancelled(uint256 indexed listingId, uint256 returnedKg);

    constructor(address governance_, address registry_, address stable_) {
        governance = IMarketGov(governance_);
        registry = IMarketRegistry(registry_);
        stable = IERC20(stable_);
    }

    function list(uint256 batchId, uint256 quantityKg, uint256 pricePerTonne) external returns (uint256 id) {
        require(batchId > 0 && batchId <= registry.batchCount(), "unknown batch");
        require(quantityKg > 0, "quantityKg must be greater than zero");
        require(pricePerTonne > 0, "pricePerTonne must be greater than zero");
        registry.marketTransfer(msg.sender, address(this), batchId, quantityKg);
        id = ++listingCount;
        listings[id] = Listing(msg.sender, batchId, quantityKg, quantityKg, pricePerTonne, Status.Open, uint64(block.timestamp));
        emit Listed(id, msg.sender, batchId, quantityKg, pricePerTonne);
    }

    function buy(uint256 listingId, uint256 quantityKg, uint256 maxPricePerTonne) external {
        Listing storage l = listings[listingId];
        require(l.status == Status.Open, "listing is not open");
        require(l.seller != msg.sender, "cannot buy your own listing");
        require(quantityKg > 0, "quantityKg must be greater than zero");
        require(quantityKg <= l.remainingKg, "not enough credits left in listing");
        require(maxPricePerTonne == 0 || l.pricePerTonne <= maxPricePerTonne, "price above your limit");
        uint256 cost = (l.pricePerTonne * quantityKg + 999) / 1000;
        uint256 fee = (cost * governance.marketFeeBps()) / 10000;
        l.remainingKg -= quantityKg;
        if (l.remainingKg == 0) l.status = Status.Filled;
        require(stable.transferFrom(msg.sender, l.seller, cost - fee), "payment failed");
        if (fee > 0) require(stable.transferFrom(msg.sender, governance.admin(), fee), "fee payment failed");
        registry.marketTransfer(address(this), msg.sender, l.batchId, quantityKg);
        emit Purchased(listingId, msg.sender, l.seller, l.batchId, quantityKg, cost, fee);
    }

    function cancel(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.status == Status.Open, "listing is not open");
        require(l.seller == msg.sender, "only the seller can cancel");
        uint256 back = l.remainingKg;
        l.status = Status.Cancelled;
        registry.marketTransfer(address(this), msg.sender, l.batchId, back);
        emit ListingCancelled(listingId, back);
    }
}
