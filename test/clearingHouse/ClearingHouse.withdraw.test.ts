import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { Exchange, TestClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse withdraw", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        exchange = _clearingHouseFixture.exchange
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt(151.3733069, 1))
        // add pool after it's initialized
        await exchange.addPool(baseToken.address, 10000)
    })

    describe("# withdraw with maker fee", () => {
        const lowerTick = 50000 // 148.3760629
        const upperTick = 50200 // 151.3733069

        beforeEach(async () => {
            // mint
            collateral.mint(alice.address, parseUnits("100", collateralDecimals))

            // prepare collateral for alice
            await deposit(alice, vault, 100, collateral)

            // mint vToken
            const quoteAmount = parseEther("0.122414646")
            await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)

            // alice add liquidity
            const addLiquidityParams = {
                baseToken: baseToken.address,
                base: 0,
                quote: quoteAmount,
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            }
            await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)
        })

        it("taker swap then withdraw and verify maker's free collateral", async () => {
            // prepare collateral for bob
            await collateral.mint(bob.address, parseUnits("100", collateralDecimals))
            await deposit(bob, vault, 100, collateral)
            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("1"))

            // bob swap
            // base: 0.0004084104205
            // B2QFee: CH actually shorts 0.0004084104205 / 0.99 = 0.0004125357783 and get 0.06151334176 quote
            // bob gets 0.06151334176 * 0.99 = 0.06089820834
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.0004084104205"),
                sqrtPriceLimitX96: "0",
            })

            // conservative config:
            //   freeCollateral = max(min(collateral, accountValue) - imReq, 0)
            //                  = max(min(collateral, accountValue) - max(totalAbsPositionValue, quoteDebtValue + totalBaseDebtValue), 0)
            //                  = max(min(100, 100+) - max(1 * 100, 1 * 100 + 0) * 0.1, 0)
            //                  = 90
            expect(await vault.getFreeCollateral(bob.address)).to.eq(parseUnits("90", collateralDecimals))
            await expect(vault.connect(bob).withdraw(collateral.address, parseUnits("90", collateralDecimals)))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, bob.address, parseUnits("90", collateralDecimals))
            expect(await collateral.balanceOf(bob.address)).to.eq(parseUnits("90", collateralDecimals))
            expect(await vault.balanceOf(bob.address)).to.eq(parseUnits("10", collateralDecimals))

            // alice remove liq 0, alice should collect fee
            // B2QFee: expect 1% of quote = 0.0006151334176 ~= 615133417572501 / 10^18
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // verify maker's free collateral
            // collateral = 100, base debt = 0, quote debt = 0.122414646
            // maker.quoteInPool -= 0.06151334176
            // maker.baseInPool += 0.0004084104205
            // maker.unrealizedPnl = positionValue + openNotional
            //                     = 0.0004084104205 * 100 + (0.0006151334176 - 0.06151334176)
            //                     = -0.02005716629
            //
            // conservative config:
            //   freeCollateral = max(min(collateral, accountValue) - imReq, 0)
            //                  = max(min(collateral, accountValue) - max(totalAbsPositionValue, quoteDebtValue + totalBaseDebtValue), 0)
            //                  = max(min(100, 100 - 0.02005716629) - max(0.0004084104205 * 100, 0 * 100 + 0.122414646) * 0.1, 0)
            //                  = 99.9677013691
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("99.967700", collateralDecimals))
        })
    })

    describe("# withdraw", () => {
        beforeEach(async () => {
            await collateral.mint(alice.address, parseUnits("20000", await collateral.decimals()))
            await deposit(alice, vault, 20000, collateral)
            const collateralAmount = parseUnits("1000", await collateral.decimals())
            await collateral.mint(bob.address, collateralAmount)
            await deposit(bob, vault, 1000, collateral)

            // alice the maker add liq. first
            await clearingHouse.connect(alice).mint(baseToken.address, parseEther("500"))
            await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("50000"))
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseUnits("500"),
                quote: parseUnits("50000"),
                lowerTick: 50000,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
        })

        it("taker do nothing and then withdraw", async () => {
            const amount = parseUnits("1000", await collateral.decimals())
            expect(await vault.getFreeCollateral(bob.address)).to.eq(amount)

            await expect(vault.connect(bob).withdraw(collateral.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, bob.address, amount)
            expect(await collateral.balanceOf(bob.address)).to.eq(amount)
            expect(await vault.balanceOf(bob.address)).to.eq("0")
        })

        it("maker withdraw after adding liquidity", async () => {
            // free collateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // min(20000, 20000) - (500 * 100 + 50000, 0) * 10% = 10000
            const amount = parseUnits("10000", await collateral.decimals())
            expect(await vault.getFreeCollateral(alice.address)).to.eq(amount)

            await expect(vault.connect(alice).withdraw(collateral.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, alice.address, amount)
            expect(await collateral.balanceOf(alice.address)).to.eq(amount)
            expect(await vault.balanceOf(alice.address)).to.eq(amount)
        })

        it("force error, withdraw without deposit", async () => {
            await expect(
                vault.connect(carol).withdraw(collateral.address, parseUnits("1000", await collateral.decimals())),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, margin requirement is larger than accountValue", async () => {
            await clearingHouse.connect(bob).mint(quoteToken.address, parseEther("10000"))
            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseUnits("10000"),
                sqrtPriceLimitX96: 0,
            })

            // conservative config:
            //   freeCollateral = max(min(collateral, accountValue) - imReq, 0)
            //                  = max(min(collateral, accountValue) - max(totalAbsPositionValue, quoteDebtValue + totalBaseDebtValue), 0)
            //                  = max(min(1000, 1000 - loss) - max(10000 - loss, 10000 + 0) * 0.1, 0)
            //                  = 0
            expect(await vault.getFreeCollateral(bob.address)).to.eq("0")
            await expect(
                vault.connect(bob).withdraw(collateral.address, parseUnits("1000", await collateral.decimals())),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, margin requirement is larger than collateral", async () => {
            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("100"))
            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseUnits("100"),
                sqrtPriceLimitX96: 0,
            })

            // carol open a short position to make price goes down.
            // So that Bob has profit
            const collateralAmount = parseUnits("1000", await collateral.decimals())
            await collateral.mint(carol.address, collateralAmount)
            await deposit(carol, vault, 1000, collateral)
            await clearingHouse.connect(carol).mint(baseToken.address, parseEther("10"))
            await clearingHouse.connect(carol).swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseUnits("1"),
                sqrtPriceLimitX96: 0,
            })

            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("110", 6), 0, 0, 0]
            })

            // conservative config:
            //   freeCollateral = max(min(collateral, accountValue) - imReq, 0)
            //                  = max(min(collateral, accountValue) - max(totalAbsPositionValue, quoteDebtValue + totalBaseDebtValue), 0)
            //                  = max(min(1000, 1000 + profit) - max(100 * 110, 100 * 110 + 0) * 0.1, 0)
            //                  = 0
            expect(await vault.getFreeCollateral(bob.address)).to.eq("0")
            await expect(
                vault.connect(bob).withdraw(collateral.address, parseUnits("1000", await collateral.decimals())),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, withdrawal amount is more than collateral", async () => {
            await expect(
                vault.connect(carol).withdraw(collateral.address, parseUnits("5000", await collateral.decimals())),
            ).to.be.revertedWith("V_NEFC")
        })

        // conservative and moderate config's freeCollateral are both bounded by user collateral,
        // so they are not susceptible to broken index prices;
        // however, as of 2021.08.25, aggressive config's freeCollateral depends entirely on the index price.
        // Therefore, we should implement an anomaly check before using the config.
        // The following test would fail without the said anomaly check.
        it("force error, free collateral should not depend solely on index price", async () => {
            await clearingHouse.connect(bob).mint(quoteToken.address, parseEther("10000"))
            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseUnits("10000"),
                sqrtPriceLimitX96: 0,
            })

            // simulate broken price oracle
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("999999999", 6), 0, 0, 0]
            })
            console.log(`positionValue: ${await clearingHouse.getPositionValue(bob.address, baseToken.address, 0)}`)
            console.log(`unrealizedPnl: ${await clearingHouse.getTotalUnrealizedPnl(bob.address)}`)

            // 65.2726375819(positionSize) * 999999999 = 65,272,637,516.627365 > 50,000,000,000
            expect(await vault.getFreeCollateral(bob.address)).to.lt(parseUnits("50000000000", collateralDecimals))
        })
    })
})
