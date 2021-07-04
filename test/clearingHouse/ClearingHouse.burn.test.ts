import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe.only("ClearingHouse.burn", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool

        await clearingHouse.addPool(baseToken.address, "10000")
    })

    describe("burn quote when debt = 10", () => {
        beforeEach(async () => {
            // prepare collateral for alice
            await collateral.mint(alice.address, toWei(10))
            await collateral.connect(alice).approve(clearingHouse.address, toWei(10))
            await clearingHouse.connect(alice).deposit(toWei(10))
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(10))

            // alice mints 10 quote
            await clearingHouse.connect(alice).mint(quoteToken.address, toWei(10))
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(9))
            expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                toWei(10), // available
                toWei(10), // debt
            ])
        })

        it("# burn quote 10 when debt = 10, available = 10", async () => {
            await expect(clearingHouse.connect(alice).burn(quoteToken.address, toWei(10)))
                .to.emit(clearingHouse, "Burned")
                .withArgs(quoteToken.address, toWei(10))

            expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                toWei(0), // available
                toWei(0), // debt
            ])

            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(10))
        })

        it("# reduce the vToken's balance of CH", async () => {
            const balanceBefore = await quoteToken.balanceOf(clearingHouse.address)
            await clearingHouse.connect(alice).burn(quoteToken.address, toWei(10))
            const balanceAfter = await quoteToken.balanceOf(clearingHouse.address)
            expect(balanceBefore.sub(toWei(10)).eq(balanceAfter)).to.be.true
        })

        it("# can not burn more than debt, even there's enough available", async () => {
            // P(50200) = 1.0001^50200 ~= 151.3733069
            await pool.initialize(encodePriceSqrt(151.3733069, 1))
            const lowerTick = 50000
            const upperTick = 50200

            // alice adds liquidity (quote only) under the current price
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(0),
                quote: toWei(10),
                lowerTick: lowerTick, // 148.3760629
                upperTick: upperTick, // 151.3733069
            })

            // prepare collateral for bob
            await collateral.mint(bob.address, toWei(100))
            await collateral.connect(bob).approve(clearingHouse.address, toWei(100))
            await clearingHouse.connect(bob).deposit(toWei(100))

            // bob mints 1 base for swap
            await clearingHouse.connect(bob).mint(baseToken.address, toWei(1))

            // bob swaps base for quote (sell base), so alice receives base as fee
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(0.01), // the amount of base to sell
                sqrtPriceLimitX96: 0,
            })

            // bob mints 100 quote for swap
            await clearingHouse.connect(bob).mint(quoteToken.address, toWei(100))

            // bob swaps quote for base (buy base), so alice receives quote as fee
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: toWei(0.01), // the amount of base to buy
                sqrtPriceLimitX96: encodePriceSqrt("155", "1"),
            })

            // alice removes 0 liquidity to collect fee
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: 0,
            })

            // alice removes liquidity
            const { liquidity } = await clearingHouse.getOpenOrder(
                alice.address,
                baseToken.address,
                lowerTick,
                upperTick,
            )
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: liquidity,
            })

            const { available: aliceQuoteAvailableAfter } = await clearingHouse.getTokenInfo(
                alice.address,
                quoteToken.address,
            )

            // contains fee
            expect(aliceQuoteAvailableAfter.gt(toWei(10))).to.be.true

            await expect(
                clearingHouse.connect(alice).burn(quoteToken.address, aliceQuoteAvailableAfter),
            ).to.be.revertedWith("CH_IA")

            // TODO: move to closePosition's tests
            // await expect(clearingHouse.connect(alice).burn(quoteToken.address, aliceQuoteAvailableAfter))
            //     .to.emit(clearingHouse, "Burned")
            //     .withArgs(quoteToken.address, toWei(10))

            // expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
            //     toWei(0), // available
            //     toWei(0), // debt
            // ])

            // const profit = aliceQuoteAvailableAfter.sub(aliceQuoteAvailableBefore)
            // expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(10).add(profit))
        })

        it("# burn quote 10 when debt = 10, available < 10", async () => {
            // P(50400) = 1.0001^50400 ~= 151.4310961
            await pool.initialize(encodePriceSqrt("154.4310961", "1"))
            const lowerTick = 50200
            const upperTick = 50400

            const { debt: aliceQuoteDebt } = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)

            // alice adds liquidity (quote only) under the current price
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(0),
                quote: toWei(10),
                lowerTick: lowerTick, // 151.3733069
                upperTick: upperTick, // 154.4310961
            })

            // prepare collateral for bob
            await collateral.mint(bob.address, toWei(100))
            await collateral.connect(bob).approve(clearingHouse.address, toWei(100))
            await clearingHouse.connect(bob).deposit(toWei(100))

            // bob mints 1 base for swap
            await clearingHouse.connect(bob).mint(baseToken.address, toWei(1))

            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(0.001),
                sqrtPriceLimitX96: 0,
            })

            const { liquidity } = await clearingHouse.getOpenOrder(
                alice.address,
                baseToken.address,
                lowerTick,
                upperTick,
            )
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick, // 151.3733069
                upperTick: upperTick, // 154.4310961
                liquidity: liquidity,
            })

            const { available: aliceQuoteAvailableAfterSwap } = await clearingHouse.getTokenInfo(
                alice.address,
                quoteToken.address,
            )

            // alice's quote got swapped
            expect(aliceQuoteAvailableAfterSwap.lt(toWei(10))).to.be.true

            const burnedAmount = aliceQuoteAvailableAfterSwap
            await expect(clearingHouse.connect(alice).burn(quoteToken.address, burnedAmount))
                .to.emit(clearingHouse, "Burned")
                .withArgs(quoteToken.address, burnedAmount)

            expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                toWei(0), // available
                aliceQuoteDebt.sub(burnedAmount), // debt
            ])
        })

        it("# force fail when the user has no vTokens", async () => {
            await expect(clearingHouse.connect(alice).burn(EMPTY_ADDRESS, 10)).to.be.revertedWith("CH_TNF")

            await expect(clearingHouse.connect(alice).burn(quoteToken.address, 0)).to.be.revertedWith("CH_IA")
        })
    })

    describe("burn base when debt = 10", () => {
        beforeEach(async () => {
            // prepare collateral for alice
            await collateral.mint(alice.address, toWei(1000))
            await collateral.connect(alice).approve(clearingHouse.address, toWei(1000))
            await clearingHouse.connect(alice).deposit(toWei(1000))
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(1000))

            // alice mints 10 base
            await clearingHouse.connect(alice).mint(baseToken.address, toWei(10))
            // TODO: the index price of base is hardcoded as $100
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(900))
            expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                toWei(10), // available
                toWei(10), // debt
            ])
        })

        it("# burn base 10 when debt = 10, available = 10", async () => {
            await expect(clearingHouse.connect(alice).burn(baseToken.address, toWei(10)))
                .to.emit(clearingHouse, "Burned")
                .withArgs(baseToken.address, toWei(10))

            expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                toWei(0), // available
                toWei(0), // debt
            ])

            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(1000))
        })

        it("# reduce the vToken's balance of CH", async () => {
            const balanceBefore = await baseToken.balanceOf(clearingHouse.address)
            await clearingHouse.connect(alice).burn(baseToken.address, toWei(10))
            const balanceAfter = await baseToken.balanceOf(clearingHouse.address)
            expect(balanceBefore.sub(toWei(10)).eq(balanceAfter)).to.be.true
        })

        it("# burn base 10 when debt = 10, available < 10", async () => {
            // P(50000) = 1.0001^50000 ~= 148.3760629
            await pool.initialize(encodePriceSqrt("148.3760629", "1"))
            const lowerTick = 50200
            const upperTick = 50400

            const { debt: aliceBaseDebt } = await clearingHouse.getTokenInfo(alice.address, baseToken.address)

            // alice adds liquidity (base only) above the current price
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(10),
                quote: toWei(0),
                lowerTick: lowerTick, // 151.3733069
                upperTick: upperTick, // 154.4310961
            })

            // prepare collateral for bob
            await collateral.mint(bob.address, toWei(100))
            await collateral.connect(bob).approve(clearingHouse.address, toWei(100))
            await clearingHouse.connect(bob).deposit(toWei(100))

            // bob mints 100 quote for swap
            await clearingHouse.connect(bob).mint(quoteToken.address, toWei(100))

            // bob swaps quote for base (buy base), so alice receives quote as fee and has less base
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: toWei(0.01), // the amount of base to buy
                sqrtPriceLimitX96: encodePriceSqrt("155", "1"),
            })

            const { liquidity } = await clearingHouse.getOpenOrder(
                alice.address,
                baseToken.address,
                lowerTick,
                upperTick,
            )
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick, // 151.3733069
                upperTick: upperTick, // 154.4310961
                liquidity: liquidity,
            })

            const { available: aliceBaseAvailableAfterSwap } = await clearingHouse.getTokenInfo(
                alice.address,
                baseToken.address,
            )

            // alice's base got swapped
            expect(aliceBaseAvailableAfterSwap.lt(toWei(10))).to.be.true

            const burnedAmount = aliceBaseAvailableAfterSwap
            await expect(clearingHouse.connect(alice).burn(baseToken.address, burnedAmount))
                .to.emit(clearingHouse, "Burned")
                .withArgs(baseToken.address, burnedAmount)

            expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                toWei(0), // available
                aliceBaseDebt.sub(burnedAmount), // debt
            ])
        })

        it("# can not burn more than debt, even there's enough available", async () => {
            // P(50000) = 1.0001^50000 ~= 148.3760629
            await pool.initialize(encodePriceSqrt("148.3760629", "1"))
            const lowerTick = 50000
            const upperTick = 50200

            // alice adds liquidity (base only) above the current price
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(10),
                quote: toWei(0),
                lowerTick: lowerTick,
                upperTick: upperTick,
            })

            // prepare collateral for bob
            await collateral.mint(bob.address, toWei(100))
            await collateral.connect(bob).approve(clearingHouse.address, toWei(100))
            await clearingHouse.connect(bob).deposit(toWei(100))

            // bob mints 100 quote for swap
            await clearingHouse.connect(bob).mint(quoteToken.address, toWei(1000))

            // bob swaps quote to base (buy base), so alice receives quote as fee
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: toWei(0.01), // the amount of base to buy
                sqrtPriceLimitX96: encodePriceSqrt("155", "1"),
            })

            // bob mints 1 extra base for swap
            await clearingHouse.connect(bob).mint(baseToken.address, toWei(1))

            // bob swaps base to quote (sell base), so alice receives base as fee
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(0.02), // the amount of base to sell
                sqrtPriceLimitX96: 0,
            })

            // // alice removes 0 liquidity to collect fee
            // await clearingHouse.connect(alice).removeLiquidity({
            //     baseToken: baseToken.address,
            //     lowerTick: lowerTick,
            //     upperTick: upperTick,
            //     liquidity: 0,
            // })

            // alice removes liquidity
            const { liquidity } = await clearingHouse.getOpenOrder(
                alice.address,
                baseToken.address,
                lowerTick,
                upperTick,
            )
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: liquidity,
            })

            const { available: aliceBaseAvailableAfter } = await clearingHouse.getTokenInfo(
                alice.address,
                baseToken.address,
            )

            // contains fee
            expect(aliceBaseAvailableAfter.gt(toWei(10))).to.be.true

            await expect(
                clearingHouse.connect(alice).burn(baseToken.address, aliceBaseAvailableAfter),
            ).to.be.revertedWith("CH_IA")
        })

        it("# force fail when the user has no vTokens", async () => {
            await expect(clearingHouse.connect(alice).burn(EMPTY_ADDRESS, 10)).to.be.revertedWith("CH_TNF")

            await expect(clearingHouse.connect(alice).burn(baseToken.address, 0)).to.be.revertedWith("CH_IA")
        })
    })
})
