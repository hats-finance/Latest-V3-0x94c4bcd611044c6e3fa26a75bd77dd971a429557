const utils = require("../utils.js");
const ERC20Mock = artifacts.require("./ERC20Mock.sol");
const TokenLockFactory = artifacts.require("./TokenLockFactory.sol");
const HATTokenLock = artifacts.require("./HATTokenLock.sol");
const HATAirdrop = artifacts.require("./HATAirdrop.sol");
const HATAirdropFactory = artifacts.require("./HATAirdropFactory.sol");
const IHATAirdrop = new ethers.utils.Interface(HATAirdrop.abi);
const { contract, web3 } = require("hardhat");
const {
  assertFunctionRaisesException, assertVMException, ZERO_ADDRESS,
} = require("../common.js");
const airdropData = require('./airdropData.json');
const { assert } = require("chai");
const { default: MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

function hashTokens(account, amount) {
  return Buffer.from(
    ethers.utils.solidityKeccak256(
      ['address', 'uint256'],
      [account, amount]
    ).slice(2),
    'hex'
  );
}

contract("HATAirdrop", (accounts) => {

  let hatAirdropFactory;
  let hatAirdrop;
  let hatAirdropImplementation;
  let token;
  let merkleTree;
  let hashes = [];
  let totalAmount = 0;
  let tokenLockFactory;
  let startTime;
  let endTime;
  let lockEndTime;
  let periods;
  let initData;

  async function setupHATAirdrop(useLock = true) {
    token = await ERC20Mock.new("Staking", "STK");

    totalAmount = 0;

    for (const [account, amount] of Object.entries(airdropData)) {
      totalAmount += parseInt(amount);
      hashes.push(hashTokens(account, amount));
    }

    merkleTree = new MerkleTree(hashes, keccak256, { sortPairs: true });
    tokenLockFactory = await TokenLockFactory.new((await HATTokenLock.new()).address, accounts[0]);
    startTime = (await web3.eth.getBlock("latest")).timestamp + 7 * 24 * 3600;
    endTime = (await web3.eth.getBlock("latest")).timestamp + (7 + 365) * 24 * 3600;
    if (useLock) {
      lockEndTime = (await web3.eth.getBlock("latest")).timestamp + 14 * 24 * 3600;
    } else {
      lockEndTime = 0;
    }
    periods = 90;

    hatAirdropImplementation = await HATAirdrop.new();
    hatAirdropFactory = await HATAirdropFactory.new();

    initData = IHATAirdrop.encodeFunctionData("initialize", [
      "QmSUXfYsk9HgrMBa7tgp3MBm8FGwDF9hnVaR9C1PMoFdS3",
      merkleTree.getHexRoot(),
      startTime,
      endTime,
      lockEndTime,
      periods,
      token.address,
      tokenLockFactory.address
    ]);

    let airdropAddress = await hatAirdropFactory.predictHATAirdropAddress(
      hatAirdropImplementation.address,
      initData
    );

    let tx = await hatAirdropFactory.createHATAirdrop(
      hatAirdropImplementation.address,
      initData,
      token.address,
      totalAmount
    );

    assert.equal(tx.logs[0].event, "HATAirdropCreated");
    assert.equal(tx.logs[0].args._hatAirdrop, airdropAddress);
    assert.equal(tx.logs[0].args._initData, initData);
    assert.equal(tx.logs[0].args._token, token.address);
    assert.equal(tx.logs[0].args._totalAmount, totalAmount);
    hatAirdrop = await HATAirdrop.at(airdropAddress);

    await token.mint(hatAirdropFactory.address, totalAmount);
  }

  it("Only owner can create airdrops", async () => {
    await setupHATAirdrop();

    await assertFunctionRaisesException(
      hatAirdropFactory.createHATAirdrop(
        hatAirdropImplementation.address,
        initData,
        token.address,
        totalAmount,
        { from: accounts[1] }
      ),
      "Ownable: caller is not the owner"
    );
  });

  it("Cannot initialize twice", async () => {
    await setupHATAirdrop();

    try {
      await hatAirdrop.initialize(
        "QmSUXfYsk9HgrMBa7tgp3MBm8FGwDF9hnVaR9C1PMoFdS3",
        await hatAirdrop.root(),
        await hatAirdrop.startTime(),
        await hatAirdrop.deadline(),
        await hatAirdrop.lockEndTime(),
        await hatAirdrop.periods(),
        await hatAirdrop.token(),
        await hatAirdrop.tokenLockFactory()
      );
      assert(false, "cannot initialize twice");
    } catch (ex) {
      assertVMException(ex, "Initializable: contract is already initialized");
    }
  });

  it("Redeem all", async () => {
    await setupHATAirdrop();

    await utils.increaseTime(7 * 24 * 3600);

    let i = 0;
    for (const [account, amount] of Object.entries(airdropData)) {
      let currentBalance = await token.balanceOf(hatAirdropFactory.address);
      const proof = merkleTree.getHexProof(hashTokens(account, amount));
      let tx = await hatAirdrop.redeem(accounts[i], amount, proof, { from: accounts[i] });
      i++;
      assert.equal(tx.logs[0].event, "TokensRedeemed");
      assert.equal(tx.logs[0].args._account.toLowerCase(), account.toLowerCase());
      assert.equal(tx.logs[0].args._amount, amount);
      assert.equal(await token.balanceOf(tx.logs[0].args._tokenLock), amount);
      assert.equal((await token.balanceOf(hatAirdropFactory.address)).toString(), currentBalance.sub(web3.utils.toBN(amount)).toString());

      let tokenLock = await HATTokenLock.at(tx.logs[0].args._tokenLock);
      assert.equal(await tokenLock.startTime(), startTime);
      assert.equal(await tokenLock.endTime(), lockEndTime);
      assert.equal(await tokenLock.periods(), periods);
      assert.equal(await tokenLock.owner(), "0x0000000000000000000000000000000000000000");
      assert.equal((await tokenLock.beneficiary()).toLowerCase(), account.toLowerCase());
      assert.equal(await tokenLock.managedAmount(), amount);
      assert.equal(await tokenLock.token(), token.address);
      assert.equal(await tokenLock.releaseStartTime(), 0);
      assert.equal(await tokenLock.vestingCliffTime(), 0);
      assert.equal(await tokenLock.revocable(), false);
      assert.equal(await tokenLock.canDelegate(), true);
    }

    assert.equal((await token.balanceOf(hatAirdropFactory.address)).toString(), "0");
  });

  it("Redeem all from multiple airdrops", async () => {
    await setupHATAirdrop();

    const initData2 = IHATAirdrop.encodeFunctionData("initialize", [
      "QmSUXfYsk9HgrMBa7tgp3MBm8FGwDF9hnVaR9C1PMoFdS3",
      merkleTree.getHexRoot(),
      startTime,
      endTime,
      lockEndTime + 1,
      periods,
      token.address,
      tokenLockFactory.address
    ]);

    let tx = await hatAirdropFactory.createHATAirdrop(
      hatAirdropImplementation.address,
      initData2,
      token.address,
      totalAmount
    );

    const hatAirdrop2 = await HATAirdrop.at(tx.logs[0].args._hatAirdrop);

    await token.mint(hatAirdropFactory.address, totalAmount);

    await utils.increaseTime(7 * 24 * 3600);

    let i = 0;
    for (const [account, amount] of Object.entries(airdropData)) {
      let currentBalance = await token.balanceOf(hatAirdropFactory.address);
      const proof = merkleTree.getHexProof(hashTokens(account, amount));
      await hatAirdropFactory.redeemMultipleAirdrops([hatAirdrop.address, hatAirdrop2.address], [amount, amount], [proof, proof], { from: accounts[i] });
      i++;
      assert.equal((await token.balanceOf(hatAirdropFactory.address)).toString(), currentBalance.sub(web3.utils.toBN(amount * 2)).toString());
    }

    assert.equal((await token.balanceOf(hatAirdropFactory.address)).toString(), "0");
  });

  it("Factory deployment fails if init fails", async () => {
    await setupHATAirdrop();

    await assertFunctionRaisesException(
      hatAirdropFactory.createHATAirdrop(
        hatAirdropFactory.address,
        initData,
        token.address,
        totalAmount
      ),
      "HATAirdropInitializationFailed"
    );
  });

  it("Cannot redeem with factory if contract is not deployed by the factory", async () => {
    await setupHATAirdrop();

    await utils.increaseTime(7 * 24 * 3600);
    
    const [account, amount] = Object.entries(airdropData)[0];
    const proof = merkleTree.getHexProof(hashTokens(account, amount));

    await assertFunctionRaisesException(
      hatAirdropFactory.redeemMultipleAirdrops([hatAirdrop.address, accounts[0]], [amount, amount], [proof, proof], { from: accounts[0] }),
      "ContractIsNotHATAirdrop"
    );
  });

  it("Cannot redeem with factory if arrays lenngths mismatch", async () => {
    await setupHATAirdrop();

    await utils.increaseTime(7 * 24 * 3600);
    
    const [account, amount] = Object.entries(airdropData)[0];
    const proof = merkleTree.getHexProof(hashTokens(account, amount));

    await assertFunctionRaisesException(
      hatAirdropFactory.redeemMultipleAirdrops([hatAirdrop.address], [amount, amount], [proof, proof], { from: accounts[0] }),
      "RedeemDataArraysLengthMismatch"
    );

    await assertFunctionRaisesException(
      hatAirdropFactory.redeemMultipleAirdrops([hatAirdrop.address], [amount], [proof, proof], { from: accounts[0] }),
      "RedeemDataArraysLengthMismatch"
    );
  });

  it("Redeem all no lock", async () => {
    await setupHATAirdrop(false);

    await utils.increaseTime(7 * 24 * 3600);

    let i = 0;
    for (const [account, amount] of Object.entries(airdropData)) {
      let currentBalance = await token.balanceOf(hatAirdropFactory.address);
      const proof = merkleTree.getHexProof(hashTokens(account, amount));
      let tx = await hatAirdrop.redeem(accounts[i], amount, proof, { from: accounts[i] });
      i++;
      assert.equal(tx.logs[0].event, "TokensRedeemed");
      assert.equal(tx.logs[0].args._account.toLowerCase(), account.toLowerCase());
      assert.equal(tx.logs[0].args._tokenLock, ZERO_ADDRESS);
      assert.equal(tx.logs[0].args._amount, amount);
      assert.equal(await token.balanceOf(account), amount);
      assert.equal((await token.balanceOf(hatAirdropFactory.address)).toString(), currentBalance.sub(web3.utils.toBN(amount)).toString());
    }

    assert.equal((await token.balanceOf(hatAirdropFactory.address)).toString(), "0");
  });

  it("Redeem after lock ended does not deploy lock", async () => {
    await setupHATAirdrop();

    await utils.increaseTime(7 * 24 * 3600);

    const dataLength = Object.entries(airdropData).length;
    let i = 0;
    for (const [account, amount] of Object.entries(airdropData).slice(0, dataLength / 2)) {
      let currentBalance = await token.balanceOf(hatAirdropFactory.address);
      const proof = merkleTree.getHexProof(hashTokens(account, amount));
      let tx = await hatAirdrop.redeem(accounts[i], amount, proof, { from: accounts[i] });
      i++;
      assert.equal(tx.logs[0].event, "TokensRedeemed");
      assert.equal(tx.logs[0].args._account.toLowerCase(), account.toLowerCase());
      assert.equal(tx.logs[0].args._amount, amount);
      assert.equal(await token.balanceOf(tx.logs[0].args._tokenLock), amount);
      assert.equal((await token.balanceOf(hatAirdropFactory.address)).toString(), currentBalance.sub(web3.utils.toBN(amount)).toString());

      let tokenLock = await HATTokenLock.at(tx.logs[0].args._tokenLock);
      assert.equal(await tokenLock.startTime(), startTime);
      assert.equal(await tokenLock.endTime(), lockEndTime);
      assert.equal(await tokenLock.periods(), periods);
      assert.equal(await tokenLock.owner(), "0x0000000000000000000000000000000000000000");
      assert.equal((await tokenLock.beneficiary()).toLowerCase(), account.toLowerCase());
      assert.equal(await tokenLock.managedAmount(), amount);
      assert.equal(await tokenLock.token(), token.address);
      assert.equal(await tokenLock.releaseStartTime(), 0);
      assert.equal(await tokenLock.vestingCliffTime(), 0);
      assert.equal(await tokenLock.revocable(), false);
      assert.equal(await tokenLock.canDelegate(), true);
    }

    await utils.increaseTime(7 * 24 * 3600);

    for (const [account, amount] of Object.entries(airdropData).slice(dataLength / 2)) {
      let currentBalance = await token.balanceOf(hatAirdropFactory.address);
      const proof = merkleTree.getHexProof(hashTokens(account, amount));
      let tx = await hatAirdrop.redeem(accounts[i], amount, proof, { from: accounts[i] });
      i++;
      assert.equal(tx.logs[0].event, "TokensRedeemed");
      assert.equal(tx.logs[0].args._account.toLowerCase(), account.toLowerCase());
      assert.equal(tx.logs[0].args._tokenLock, ZERO_ADDRESS);
      assert.equal(tx.logs[0].args._amount, amount);
      assert.equal(await token.balanceOf(account), amount);
      assert.equal((await token.balanceOf(hatAirdropFactory.address)).toString(), currentBalance.sub(web3.utils.toBN(amount)).toString());
    }

    assert.equal((await token.balanceOf(hatAirdropFactory.address)).toString(), "0");
  });

  it("Cannot redeem before start time", async () => {
    await setupHATAirdrop();

    const [account, amount] = Object.entries(airdropData)[0];
    const proof = merkleTree.getHexProof(hashTokens(account, amount));
    await assertFunctionRaisesException(
      hatAirdrop.redeem(accounts[0], amount, proof),
      "CannotRedeemBeforeStartTime"
    );

    await utils.increaseTime(7 * 24 * 3600);

    let tx = await hatAirdrop.redeem(accounts[0], amount, proof);
    assert.equal(tx.logs[0].event, "TokensRedeemed");
    assert.equal(tx.logs[0].args._account.toLowerCase(), account.toLowerCase());
    assert.equal(tx.logs[0].args._amount, amount);
    assert.equal(await token.balanceOf(tx.logs[0].args._tokenLock), amount);
  });

  it("Cannot redeem after deadline", async () => {
    await setupHATAirdrop();

    const [account, amount] = Object.entries(airdropData)[0];
    const proof = merkleTree.getHexProof(hashTokens(account, amount));

    await utils.increaseTime(7 * 24 * 3600);

    let tx = await hatAirdrop.redeem(accounts[0], amount, proof);
    assert.equal(tx.logs[0].event, "TokensRedeemed");
    assert.equal(tx.logs[0].args._account.toLowerCase(), account.toLowerCase());
    assert.equal(tx.logs[0].args._amount, amount);
    assert.equal(await token.balanceOf(tx.logs[0].args._tokenLock), amount);

    await utils.increaseTime(365 * 24 * 3600);

    const [account2, amount2] = Object.entries(airdropData)[1];
    const proof2 = merkleTree.getHexProof(hashTokens(account2, amount2));

    await assertFunctionRaisesException(
      hatAirdrop.redeem(accounts[1], amount2, proof2, { from: accounts[1] }),
      "CannotRedeemAfterDeadline"
    );
  });

  it("Cannot redeem for another account", async () => {
    await setupHATAirdrop();

    const [account, amount] = Object.entries(airdropData)[0];
    const proof = merkleTree.getHexProof(hashTokens(account, amount));

    await utils.increaseTime(7 * 24 * 3600);

    await assertFunctionRaisesException(
      hatAirdrop.redeem(accounts[0], amount, proof, { from: accounts[1] }),
      "RedeemerMustBeBeneficiary"
    );

    let tx = await hatAirdrop.redeem(accounts[0], amount, proof);
    assert.equal(tx.logs[0].event, "TokensRedeemed");
    assert.equal(tx.logs[0].args._account.toLowerCase(), account.toLowerCase());
    assert.equal(tx.logs[0].args._amount, amount);
    assert.equal(await token.balanceOf(tx.logs[0].args._tokenLock), amount);

  });

  it("Cannot redeem twice", async () => {
    await setupHATAirdrop();

    const [account, amount] = Object.entries(airdropData)[0];
    const proof = merkleTree.getHexProof(hashTokens(account, amount));

    await utils.increaseTime(7 * 24 * 3600);

    let tx = await hatAirdrop.redeem(accounts[0], amount, proof);
    assert.equal(tx.logs[0].event, "TokensRedeemed");
    assert.equal(tx.logs[0].args._account.toLowerCase(), account.toLowerCase());
    assert.equal(tx.logs[0].args._amount, amount);
    assert.equal(await token.balanceOf(tx.logs[0].args._tokenLock), amount);

    await assertFunctionRaisesException(
      hatAirdrop.redeem(accounts[0], amount, proof),
      "LeafAlreadyRedeemed"
    );
  });

  it("Cannot redeem invalid proof", async () => {
    await setupHATAirdrop();

    const [account, amount] = Object.entries(airdropData)[0];

    await utils.increaseTime(7 * 24 * 3600);

    await assertFunctionRaisesException(
      hatAirdrop.redeem(accounts[0], amount, [web3.utils.randomHex(32)]),
      "InvalidMerkleProof"
    );

    const proof = merkleTree.getHexProof(hashTokens(account, amount));

    await assertFunctionRaisesException(
      hatAirdrop.redeem(accounts[0], "0", proof),
      "InvalidMerkleProof"
    );

    let tx = await hatAirdrop.redeem(accounts[0], amount, proof);
    assert.equal(tx.logs[0].event, "TokensRedeemed");
    assert.equal(tx.logs[0].args._account.toLowerCase(), account.toLowerCase());
    assert.equal(tx.logs[0].args._amount, amount);    
    assert.equal(await token.balanceOf(tx.logs[0].args._tokenLock), amount);
  });

  it("Withdraw tokens", async () => {
    await setupHATAirdrop();

    await assertFunctionRaisesException(
      hatAirdropFactory.withdrawTokens(token.address, 1, { from: accounts[1] }),
      "Ownable: caller is not the owner"
    );

    await utils.increaseTime(7 * 24 * 3600);

    const [account, amount] = Object.entries(airdropData)[0];
    const proof = merkleTree.getHexProof(hashTokens(account, amount));

    let tx = await hatAirdrop.redeem(accounts[0], amount, proof);
    assert.equal(tx.logs[0].event, "TokensRedeemed");
    assert.equal(tx.logs[0].args._account.toLowerCase(), account.toLowerCase());
    assert.equal(tx.logs[0].args._amount, amount);
    assert.equal(await token.balanceOf(tx.logs[0].args._tokenLock), amount);

    await utils.increaseTime(365 * 24 * 3600);

    tx = await hatAirdropFactory.withdrawTokens(token.address, web3.utils.toBN((totalAmount - parseInt(amount))));
    
    assert.equal(tx.logs[0].event, "TokensWithdrawn");
    assert.equal(tx.logs[0].args._owner.toLowerCase(), accounts[0].toLowerCase());
    assert.equal(tx.logs[0].args._amount.toString(), web3.utils.toBN((totalAmount - parseInt(amount))).toString());
    assert.equal((await token.balanceOf(hatAirdropFactory.address)).toString(), "0");
  });
});
