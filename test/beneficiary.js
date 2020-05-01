/*
    This test is testing seting new beneficiary in provider channel.
    Tested functions can be found in smart-contract code at `contracts/AccountantImplementation.sol`.
*/

const { BN } = require('openzeppelin-test-helpers')
const {
    generateChannelId,
    topUpTokens,
    topUpEthers,
    setupConfig
} = require('./utils/index.js')
const wallet = require('./utils/wallet.js')
const {
    signChannelBeneficiaryChange,
    signChannelLoanReturnRequest,
    signIdentityRegistration,
    generatePromise
} = require('./utils/client.js')

const MystToken = artifacts.require("MystToken")
const MystDex = artifacts.require("MystDEX")
const Registry = artifacts.require("Registry")
const AccountantImplementation = artifacts.require("TestAccountantImplementation")
const ChannelImplementationProxy = artifacts.require("ChannelImplementationProxy")

const OneToken = web3.utils.toWei(new BN('100000000'), 'wei')
const OneEther = web3.utils.toWei(new BN(1), 'ether')
const Zero = new BN(0)

// const operatorPrivKey = Buffer.from('d6dd47ec61ae1e85224cec41885eec757aa77d518f8c26933e5d9f0cda92f3c3', 'hex')
const operator = wallet.generateAccount(Buffer.from('d6dd47ec61ae1e85224cec41885eec757aa77d518f8c26933e5d9f0cda92f3c3', 'hex'))  // Generate accountant operator wallet
const provider = wallet.generateAccount()

contract("Setting beneficiary tests", ([txMaker, operatorAddress, beneficiaryA, beneficiaryB, beneficiaryC, ...otherAccounts]) => {
    let token, hermes, registry, beneficiaryChangeSignature
    before(async () => {
        token = await MystToken.new()
        const dex = await MystDex.new()
        const accountantImplementation = await AccountantImplementation.new(token.address, operator.address, 0, OneToken)
        const channelImplementation = await ChannelImplementationProxy.new()
        const config = await setupConfig(txMaker, channelImplementation.address, accountantImplementation.address)
        registry = await Registry.new(token.address, dex.address, config.address, 0, 1)

        // Give some ethers for gas for operator
        await topUpEthers(txMaker, operator.address, OneEther)

        // Give tokens for txMaker so it could use them registration and lending stuff
        await topUpTokens(token, txMaker, OneToken)
        await token.approve(registry.address, OneToken)  
    })

    it("should register and initialize hermes hub", async () => {
        await registry.registerAccountant(operator.address, 10, 0, OneToken)
        const hermesId = await registry.getAccountantAddress(operator.address)
        expect(await registry.isAccountant(hermesId)).to.be.true

        // Initialise hermes object
        hermes = await AccountantImplementation.at(hermesId)

        // Topup some balance for hermes
        topUpTokens(token, hermes.address, new BN(100000))
    })

    it("should register new provider and open hermes channel", async () => {
        const amountToLend = new BN(888)
        const expectedChannelId = generateChannelId(provider.address, hermes.address)

        // TopUp payment channel
        const channelAddress =  await registry.getChannelAddress(provider.address, hermes.address)
        await topUpTokens(token, channelAddress, amountToLend)

        // Register identity and open channel with hermes
        const signature = signIdentityRegistration(registry.address, hermes.address, amountToLend, Zero, beneficiaryA, provider)
        await registry.registerIdentity(hermes.address, amountToLend, Zero, beneficiaryA, signature)
        expect(await registry.isRegistered(provider.address)).to.be.true
        expect(await hermes.isOpened(expectedChannelId)).to.be.true
    })

    it("should settle into proper beneficiary", async () => {
        const channelId = generateChannelId(provider.address, hermes.address)
        const channelState = Object.assign({}, { channelId }, await hermes.channels(channelId))
        const amountToPay = new BN('100')
        const balanceBefore = await token.balanceOf(beneficiaryA)

        const promise = generatePromise(amountToPay, Zero, channelState, operator)
        await hermes.settlePromise(promise.channelId, promise.amount, promise.fee, promise.lock, promise.signature)

        const balanceAfter = await token.balanceOf(beneficiaryA)
        balanceAfter.should.be.bignumber.equal(balanceBefore.add(amountToPay))
    })

    it("should allow setting new beneficiary and use it in next settlement", async () => {
        const channelId = generateChannelId(provider.address, hermes.address)
        const nonce = new BN(1)
        const signature = signChannelBeneficiaryChange(channelId, beneficiaryB, nonce, provider)

        // Set new beneficiary
        await hermes.setBeneficiary(channelId, beneficiaryB, nonce, signature)
        expect((await hermes.channels(channelId)).beneficiary).to.be.equal(beneficiaryB)

        // Settle into proper beneficiary address
        const channelState = Object.assign({}, { channelId }, await hermes.channels(channelId))
        const amountToPay = new BN('100')
        const balanceBefore = await token.balanceOf(beneficiaryB)

        const promise = generatePromise(amountToPay, Zero, channelState, operator)
        await hermes.settlePromise(promise.channelId, promise.amount, promise.fee, promise.lock, promise.signature)

        const balanceAfter = await token.balanceOf(beneficiaryB)
        balanceAfter.should.be.bignumber.equal(balanceBefore.add(amountToPay))
    })

    it("expect settleWithBeneficiary to set new beneficiary", async () => {
        const balanceBefore = await token.balanceOf(beneficiaryC)
        const channelId = generateChannelId(provider.address, hermes.address)
        const channelState = Object.assign({}, { channelId }, await hermes.channels(channelId))
        const amountToPay = new BN('100')
        const nonce = new BN(2)

        beneficiaryChangeSignature = signChannelBeneficiaryChange(channelId, beneficiaryC, nonce, provider) // remember signature for the future
        const promise = generatePromise(amountToPay, Zero, channelState, operator)
        await hermes.settleWithBeneficiary(promise.channelId, promise.amount, promise.fee, promise.lock, promise.signature, beneficiaryC, nonce, beneficiaryChangeSignature)

        expect((await hermes.channels(channelId)).beneficiary).to.be.equal(beneficiaryC)

        const balanceAfter = await token.balanceOf(beneficiaryC)
        balanceAfter.should.be.bignumber.equal(balanceBefore.add(amountToPay))
    })

    it("should send proper transactorFee into txMaker address", async () => {
        const beneficiaryBalanceBefore = await token.balanceOf(beneficiaryA)
        const txMakerBalanceBefore = await token.balanceOf(txMaker)
        const channelId = generateChannelId(provider.address, hermes.address)
        const channelState = Object.assign({}, { channelId }, await hermes.channels(channelId))
        const amountToPay = new BN('88')
        const transactorFee = new BN('8')
        const nonce = new BN(3)

        const signature = signChannelBeneficiaryChange(channelId, beneficiaryA, nonce, provider)
        const promise = generatePromise(amountToPay, transactorFee, channelState, operator)
        await hermes.settleWithBeneficiary(promise.channelId, promise.amount, promise.fee, promise.lock, promise.signature, beneficiaryA, nonce, signature)

        expect((await hermes.channels(channelId)).beneficiary).to.be.equal(beneficiaryA)

        const txMakerBalanceAfter = await token.balanceOf(txMaker)
        txMakerBalanceAfter.should.be.bignumber.equal(txMakerBalanceBefore.add(transactorFee))

        const beneficiaryBalanceAfter = await token.balanceOf(beneficiaryA)
        beneficiaryBalanceAfter.should.be.bignumber.equal(beneficiaryBalanceBefore.add(amountToPay))
    })

    it("should not allow using same beneficiaryChange signature twice", async () => {
        const channelId = generateChannelId(provider.address, hermes.address)
        const nonce = new BN(2)

        await hermes.setBeneficiary(channelId, beneficiaryC, nonce, beneficiaryChangeSignature).should.be.rejected
        expect((await hermes.channels(channelId)).beneficiary).to.be.equal(beneficiaryA)
    })
})