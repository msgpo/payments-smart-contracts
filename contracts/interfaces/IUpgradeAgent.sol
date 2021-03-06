// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.5.12 <0.7.0;

/**
 * Upgrade agent interface inspired by Lunyr.
 *
 * Upgrade agent transfers tokens to a new contract.
 * Upgrade agent itself can be the token contract, or just a middle man contract doing the heavy lifting.
 */
abstract contract IUpgradeAgent {
    uint public originalSupply;
    function isUpgradeAgent() public virtual pure returns (bool);
    function upgradeFrom(address _from, uint256 _value) public virtual;
}
