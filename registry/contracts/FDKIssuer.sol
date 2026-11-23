// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @title FDK issuance reserve
/// @notice FDK is the native gas token of the Fedrok chain: it pays network
///         fees and block-generator stakes. It is a utility token: it is
///         never a payment currency on the platform and carries no yield,
///         equity or profit rights.
///
///         The genesis block places the full FDK supply cap in this contract,
///         minus the genesis allocations. FDK only leaves it through issuance
///         contracts that governance lists as minters (none at genesis), so
///         "issued supply" is cap minus this contract's balance, which anyone
///         can verify. Burned FDK goes to the dead address.
contract FDKIssuer {
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public immutable governance;
    mapping(address => bool) public isMinter;
    uint256 public totalIssued;
    uint256 public totalBurned;

    event MinterSet(address indexed minter, bool allowed);
    event Issued(address indexed minter, address indexed to, uint256 amount, string reason);
    event Burned(address indexed from, uint256 amount, string reason);

    constructor(address governance_) payable {
        governance = governance_;
    }

    function setMinter(address minter, bool allowed) external {
        require(msg.sender == IGovAdmin(governance).admin(), "governance only");
        isMinter[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    function reserve() external view returns (uint256) {
        return address(this).balance;
    }

    /// @dev Only the protocol contracts listed by governance can issue.
    function issue(address to, uint256 amount, string calldata reason) external {
        require(isMinter[msg.sender], "not an FDK issuance contract");
        require(amount <= address(this).balance, "FDK supply cap reached");
        totalIssued += amount;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "FDK transfer failed");
        emit Issued(msg.sender, to, amount, reason);
    }

    /// @notice Burn FDK, e.g. to record carbon consumption or utility use.
    function burn(string calldata reason) external payable {
        require(msg.value > 0, "amount must be greater than zero");
        require(bytes(reason).length > 0 && bytes(reason).length <= 200, "reason is required (max 200 chars)");
        totalBurned += msg.value;
        (bool ok, ) = BURN_ADDRESS.call{value: msg.value}("");
        require(ok, "burn failed");
        emit Burned(msg.sender, msg.value, reason);
    }

    receive() external payable {
        revert("use burn()");
    }
}

interface IGovAdmin {
    function admin() external view returns (address);
}
