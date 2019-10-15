pragma solidity ^0.5.12;

import { ECDSA } from "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";
import { SafeMath } from "openzeppelin-solidity/contracts/math/SafeMath.sol";
import { IERC20 } from "openzeppelin-solidity/contracts/token/ERC20/IERC20.sol";
import { FundsRecovery } from "./FundsRecovery.sol";

interface AccountantContract {
    function getOperator() external view returns (address);
}

contract ChannelImplementation is FundsRecovery {
    using ECDSA for bytes32;
    using SafeMath for uint256;

    string constant EXIT_PREFIX = "Exit request:";
    uint256 constant DELAY_BLOCKS = 18000;  // +/- 4 days

    struct ExitRequest {
        uint256 timelock;          // block number after which exit can be finalized
        address beneficiary;       // address where funds will be send after finalizing exit request
    }

    struct Accountant {
        address operator;          // signing address
        address contractAddress;   // accountant smart contract address, funds will be send there
        uint256 settled;           // total amount already settled by accountant 
    }

    ExitRequest public exitRequest;
    Accountant public accountant;
    address public operator;          // channel operator = sha3(IdentityPublicKey)[:20]
    address public dex;

    event PromiseSettled(address beneficiary, uint256 amount, uint256 totalSettled);
    event ChannelInitialised(address operator, address accountant);
    event ExitRequested(uint256 timelock);
    event FinalizeExit(uint256 amount);

    /*
      ------------------------------------------- SETUP -------------------------------------------
    */

    // Fallback function - redirect ethers topup into DEX
    function () external payable {
        (bool success, bytes memory data) = address(dex).call.value(msg.value)(msg.data);
        require(success, "Tx was rejected by DEX");
    }

    // Because of proxy pattern this function is used insted of constructor.
    // Have to be called right after proxy deployment.
    function initialize(address _token, address _dex, address _identityHash, address _accountantId, uint256 _fee) public {
        require(!isInitialized(), "Is already initialized");
        require(_identityHash != address(0), "Identity can't be zero");
        require(_accountantId != address(0), "AccountantID can't be zero");
        require(_token != address(0), "Token can't be deployd into zero address");

        token = IERC20(_token);
        dex = _dex;

        // Transfer required fee to msg.sender (most probably Registry)
        if (_fee > 0) {
            token.transfer(msg.sender, _fee);
        }

        operator = _identityHash;
        accountant = Accountant(AccountantContract(_accountantId).getOperator(), _accountantId, 0);

        emit ChannelInitialised(_identityHash, _accountantId);
    }

    function isInitialized() public view returns (bool) {
        return operator != address(0);
    }

    /*
      -------------------------------------- MAIN FUNCTIONALITY -----------------------------------
    */

    // Settle promise
    // signedMessage: channelId, totalSettleAmount, fee, hashlock
    // _lock is random number generated by receiver used in HTLC
    function settlePromise(uint256 _amount, uint256 _transactorFee, bytes32 _lock, bytes memory _signature) public {
        bytes32 _hashlock = keccak256(abi.encode(_lock));
        address _channelId = address(this);
        address _signer = keccak256(abi.encodePacked(uint256(_channelId), _amount, _transactorFee, _hashlock)).recover(_signature);
        require(_signer == operator, "have to be signed by channel operator");

        // Calculate amount of tokens to be claimed.
        uint256 _unpaidAmount = _amount.sub(accountant.settled);
        require(_unpaidAmount > 0, "amount to settle should be greater that already settled");

        // If signer has less tokens than asked to transfer, we can transfer as much as he has already
        // and rest tokens can be transferred via same promise but in another tx 
        // when signer will top up channel balance.
        uint256 _currentBalance = token.balanceOf(_channelId);
        if (_unpaidAmount > _currentBalance) {
            _unpaidAmount = _currentBalance;
        }

        // Increase already paid amount
        accountant.settled = accountant.settled.add(_unpaidAmount);

        // Send tokens
        token.transfer(accountant.contractAddress, _unpaidAmount.sub(_transactorFee));

        // Pay fee to transaction maker
        if (_transactorFee > 0) {
            token.transfer(msg.sender, _transactorFee);
        }

        emit PromiseSettled(accountant.contractAddress, _unpaidAmount, accountant.settled);
    }

    // Returns blocknumber until which exit request should be locked
    function getTimelock() internal view returns (uint256) {
        return block.number + DELAY_BLOCKS;
    }

    // Start withdrawal of deposited but still not settled funds
    // NOTE _validUntil is needed for replay protection
    function requestExit(address _beneficiary, uint256 _validUntil, bytes memory _signature) public {
        uint256 _timelock = getTimelock();

        require(exitRequest.timelock == 0, "new exit can be requested only when old one was finalised");
        require(_validUntil > block.number, "valid until have to be greater than current block number");
        require(_timelock > _validUntil, "request have to be valid shorter than DELAY_BLOCKS");
        require(_beneficiary != address(0), "beneficiary can't be zero address");

        if (msg.sender != operator) {
            address _channelId = address(this);
            address _signer = keccak256(abi.encodePacked(EXIT_PREFIX, _channelId, _beneficiary, _validUntil)).recover(_signature);
            require(_signer == operator, "have to be signed by operator");
        }

        exitRequest = ExitRequest(_timelock, _beneficiary);

        emit ExitRequested(_timelock);
    }

    // Anyone can finalize exit request after timelock block passed
    function finalizeExit() public {
        require(exitRequest.timelock != 0 && block.number >= exitRequest.timelock, "exit have to be requested and timelock have to be in past");

        // Exit with all not settled funds
        uint256 amount = token.balanceOf(address(this));
        token.transfer(exitRequest.beneficiary, amount);

        exitRequest = ExitRequest(0, address(0));  // deleting request
        emit FinalizeExit(amount);
    }

    /*
      ------------------------------------------ HELPERS ------------------------------------------
    */

    // Setting new destination of funds recovery.
    // TODO: Protect from replly attack
    string constant FUNDS_DESTINATION_PREFIX = "Set funds destination:";
    function setFundsDestinationByCheque(address payable _newDestination, bytes memory _signature) public {
        require(_newDestination != address(0));

        address _signer = keccak256(abi.encodePacked(FUNDS_DESTINATION_PREFIX, _newDestination)).recover(_signature);
        require(_signer == operator, "Have to be signed by proper identity");

        emit DestinationChanged(fundsDestination, _newDestination);
        fundsDestination = _newDestination;
    }
}
