// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IStableGov {
    function stableIssuer() external view returns (address);
}

/// @title fUSD settlement stablecoin (devnet stand-in)
/// @notice ERC-20, 6 decimals. Stands in for whichever regulated stablecoin
///         (USD or CHF) Fedrok selects. All payments between parties,
///         including every marketplace purchase, settle in this token.
contract FUSD {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    uint256 public totalMinted;
    uint256 public totalRedeemed;
    address public immutable governance;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event StableMinted(address indexed to, uint256 amount, string reserveRef);
    event StableRedeemed(address indexed from, uint256 amount, string redemptionRef);

    constructor(address governance_, string memory name_, string memory symbol_) {
        governance = governance_;
        name = name_;
        symbol = symbol_;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, string.concat("insufficient ", symbol, " allowance"));
            allowance[from][msg.sender] = a - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Issuer-only: mint against a reserve attestation.
    function mint(address to, uint256 amount, string calldata reserveRef) external {
        require(msg.sender == IStableGov(governance).stableIssuer(), "only the stablecoin issuer can mint");
        require(to != address(0), "to must be a 0x address");
        require(amount > 0, "amount must be greater than zero");
        require(bytes(reserveRef).length > 0 && bytes(reserveRef).length <= 200, "reserveRef is required (max 200 chars)");
        totalSupply += amount;
        totalMinted += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
        emit StableMinted(to, amount, reserveRef);
    }

    /// @notice Holder redemption: burns tokens; the issuer pays out off-chain.
    function redeem(uint256 amount, string calldata redemptionRef) external {
        require(amount > 0, "amount must be greater than zero");
        require(balanceOf[msg.sender] >= amount, string.concat("insufficient ", symbol));
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalRedeemed += amount;
        emit Transfer(msg.sender, address(0), amount);
        emit StableRedeemed(msg.sender, amount, redemptionRef);
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "to must be a 0x address");
        require(value > 0, "amount must be greater than zero");
        require(balanceOf[from] >= value, string.concat("insufficient ", symbol));
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
