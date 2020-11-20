const { ApiPromise, WsProvider } = require("@polkadot/api");
const { isHex } = require("@polkadot/util");
const fs = require("fs");
const axios = require("axios");
const Ora = require("ora");
const commaNumber = require("comma-number");

let DOT_DECIMAL_PLACES = 10000000000;
let fiat = 0;
let network = "polkadot"; // default to polkadot network (can be changed to kusama using command line arg)
let networkName = "Polkadot";
let networkDenom = "DOT";

(async () => {
	args = process.argv;
	let provider = null;
	if (args.length > 2 && args[2] === "kusama") {
		// if there is a command line arg for kusama, use kusama network
		console.log("Generating real time staking activity analysis for Kusama");
		network = "kusama";
		networkName = "Kusama";
		networkDenom = "KSM";
		const res = await axios(
			`https://api.coingecko.com/api/v3/simple/price?ids=${network}&vs_currencies=usd`
		);
		fiat = res.data.kusama.usd;
		provider = new WsProvider("wss://kusama-rpc.polkadot.io");
		DOT_DECIMAL_PLACES *= 100;
	} else {
		// default to polkadot
		console.log("Generating real time staking activity analysis for Polkadot");
		const res = await axios(
			`https://api.coingecko.com/api/v3/simple/price?ids=${network}&vs_currencies=usd`
		);
		fiat = res.data.polkadot.usd;
		provider = new WsProvider("wss://rpc.polkadot.io");
	}

	console.log(`\nNetwork Name: ${networkName}`);
	console.log(
		`1 ${networkDenom} current price: ${commaNumber(fiat.toFixed(2))} USD`
	);
	console.log(
		`$1k in ${networkDenom}: ${commaNumber(
			((1 / fiat) * 1000).toFixed(2)
		)} ${networkDenom}`
	);
	console.log(
		`$10k in ${networkDenom}: ${commaNumber(
			((1 / fiat) * 10000).toFixed(2)
		)} ${networkDenom}`
	);
	const api = await ApiPromise.create({ provider });

	const spinnerAccounts = new Ora({
		text: "Fetching Accounts",
		spinner: process.argv[2],
	});

	spinnerAccounts.start();

	const accountIds = getAccountId(await api.query.system.account.keys());
	// get all account identity info

	spinnerAccounts.succeed();

	console.log("====================");
	console.log(`Total Accounts: ${commaNumber(accountIds.length)}`);

	// console.log(accountIds.length);
	console.log("\n=========================");

	const chunkedAccounts = chunkArray(accountIds, 10000);
	const accountsInfo = [];

	const spinnerValidators = new Ora({
		text: "Fetching Validators",
		spinner: process.argv[2],
	});

	spinnerValidators.start();

	const validators = await fetchValidators(api);

	spinnerValidators.succeed();

	const spinnerActiveAndOverSub = new Ora({
		text: "Fetching StakingInfo",
		spinner: process.argv[2],
	});

	spinnerActiveAndOverSub.start();

	const {
		activeNominators,
		overSubscribedNominators,
	} = await fetchValidatorsStakingInfo(api, validators);

	spinnerActiveAndOverSub.succeed();

	const spinnerStakingInfo = new Ora({
		text: "Fetching Staking Info",
		spinner: process.argv[2],
	});

	spinnerStakingInfo.start();

	const accountsStaking = [];
	for (let i = 0; i < chunkedAccounts.length; i++) {
		await Promise.all(
			chunkedAccounts[i].map(async (id) => {
				const isStaking = await fetchAccountStaking(id, api, validators);
				if (isStaking) {
					accountsStaking.push(id);
				}
			})
		);
	}

	spinnerStakingInfo.succeed();

	const spinnerBalances = new Ora({
		text: "Fetching Balances",
		spinner: process.argv[2],
	});

	spinnerBalances.start();

	for (let i = 0; i < chunkedAccounts.length; i++) {
		const info = await Promise.all(
			chunkedAccounts[i].map(async (x) => {
				const info = await api.derive.balances.all(x);
				return {
					accountId: x,
					freeBalance: parseInt(info.freeBalance) / DOT_DECIMAL_PLACES,
					freeBalanceFiat:
						(parseInt(info.freeBalance) / DOT_DECIMAL_PLACES) * fiat,
					lockedBalance: parseInt(info.lockedBalance) / DOT_DECIMAL_PLACES,
					lockedBalanceFiat:
						(parseInt(info.lockedBalance) / DOT_DECIMAL_PLACES) * fiat,
					totalBalance:
						(parseInt(info.freeBalance) + parseInt(info.reservedBalance)) /
						DOT_DECIMAL_PLACES,
					totalBalanceFiat:
						((parseInt(info.freeBalance) + parseInt(info.reservedBalance)) /
							DOT_DECIMAL_PLACES) *
						fiat,
					isValidator: validators.includes(x),
					isStaking: accountsStaking.includes(x),
				};
			})
		);
		accountsInfo.push(...info);
	}

	spinnerBalances.succeed();
	const jsonData = JSON.stringify(accountsInfo);

	const stakingAccounts = accountsInfo.filter((x) => x.isStaking);

	const nominatorAccounts = accountsInfo.filter(
		(x) => x.isStaking && !x.isValidator
	);

	console.log("Total Accounts: " + commaNumber(accountsInfo.length));

	console.log("\nOverall Staking Summary: ");

	console.log(
		"Accounts Staking including validators: " +
			commaNumber(stakingAccounts.length)
	);

	console.log(
		"Accounts Staking not including validators: " +
			commaNumber(nominatorAccounts.length)
	);

	console.log("\n=========================");

	console.log("Accounts Not Staking Drilldown: ");

	console.log(
		`Accounts Not Staking: ${commaNumber(
			accountsInfo.length - stakingAccounts.length
		)}`
	);

	console.log(
		`% of accounts not staking: ${(
			((accountsInfo.length - stakingAccounts.length) / accountsInfo.length) *
			100
		).toFixed(2)} %`
	);

	const freeBalanceLt1 = accountsInfo.filter(
		(x) => x.freeBalance < 1 && !x.isStaking
	);

	const freeBalanceLt1NolockedAmount = freeBalanceLt1.filter(
		(x) => x.lockedBalance == 0
	);
	const freeBalanceGt1 = accountsInfo.filter(
		(x) => x.freeBalance > 1 && !x.isStaking
	);

	const freeBalanceGt1NolockedAmount = freeBalanceGt1.filter(
		(x) => x.lockedBalance == 0
	);
	const freeBalanceGt1NolockedAmountLt1000Fiat = freeBalanceGt1NolockedAmount.filter(
		(x) => x.freeBalanceFiat < 1000
	);

	const freeBalanceGt1NolockedAmountGt1000FiatLt1000Fiat = freeBalanceGt1NolockedAmount.filter(
		(x) => x.freeBalanceFiat > 1000 && x.freeBalanceFiat < 10000
	);

	const freeBalanceGt1NolockedAmountLt10000Fiat = freeBalanceGt1NolockedAmount.filter(
		(x) => x.freeBalanceFiat < 10000
	);

	const freeBalanceGt1NolockedAmountGt10000Fiat = freeBalanceGt1NolockedAmount.filter(
		(x) => x.freeBalanceFiat > 10000
	);

	console.log(
		`Accounts with free balance > 0 DOT && free balance < 1 DOT && bonded = 0: ${commaNumber(
			freeBalanceLt1NolockedAmount.length
		)}`
	);

	console.log(
		`Accounts with free balance >  1 DOT && free balance < ${(
			(1 / fiat) *
			1000
		).toFixed(2)} ${networkDenom} && bonded = 0: ${commaNumber(
			freeBalanceGt1NolockedAmountLt1000Fiat.length
		)}`
	);

	console.log(
		`Accounts with free balance >  ${((1 / fiat) * 1000).toFixed(
			2
		)} ${networkDenom} && free balance < ${((1 / fiat) * 10000).toFixed(
			2
		)} ${networkDenom} && bonded = 0: ${commaNumber(
			freeBalanceGt1NolockedAmountGt1000FiatLt1000Fiat.length
		)}`
	);

	console.log(
		`Accounts with free balance > ${((1 / fiat) * 10000).toFixed(
			2
		)} ${networkDenom} && bonded = 0: ${commaNumber(
			freeBalanceGt1NolockedAmountGt10000Fiat.length
		)}`
	);

	console.log(
		"\n% Analysis (in denominator taking total accounts not staking): "
	);

	console.log(
		`Accounts with free balance greater than 1 DOT: ${(
			(freeBalanceGt1.length / (accountsInfo.length - stakingAccounts.length)) *
			100
		).toFixed(3)} %`
	);

	console.log(
		`Accounts with free balance > 0 DOT && free balance < 1 DOT && bonded = 0: ${(
			(freeBalanceLt1NolockedAmount.length /
				(accountsInfo.length - stakingAccounts.length)) *
			100
		).toFixed(3)} %`
	);

	console.log(
		`Accounts with free balance >  1 DOT && free balance < ${(
			(1 / fiat) *
			1000
		).toFixed(2)} ${networkDenom} && bonded = 0: ${(
			(freeBalanceGt1NolockedAmountLt1000Fiat.length /
				(accountsInfo.length - stakingAccounts.length)) *
			100
		).toFixed(3)} %`
	);

	console.log(
		`Accounts with free balance >  ${((1 / fiat) * 1000).toFixed(
			2
		)} ${networkDenom} && free balance < ${((1 / fiat) * 10000).toFixed(
			2
		)} ${networkDenom} && bonded = 0: ${(
			(freeBalanceGt1NolockedAmountGt1000FiatLt1000Fiat.length /
				(accountsInfo.length - stakingAccounts.length)) *
			100
		).toFixed(3)} %`
	);

	console.log(
		`Accounts with free balance > ${((1 / fiat) * 10000).toFixed(
			2
		)} ${networkDenom} && bonded = 0: ${(
			(freeBalanceGt1NolockedAmountGt10000Fiat.length /
				(accountsInfo.length - stakingAccounts.length)) *
			100
		).toFixed(3)} %`
	);

	const bondedButNotStaking = accountsInfo.filter(
		(x) => x.lockedBalance > 0 && !x.isStaking
	);

	console.log(
		`Account that have bonded something but not staking: ${commaNumber(
			bondedButNotStaking.length
		)} `
	);

	const totalLt1000BondedGt1 = bondedButNotStaking.filter(
		(x) => x.lockedBalance > 1 && x.totalBalance < 1000
	);

	const totalLt10000BondedGt1 = bondedButNotStaking.filter(
		(x) =>
			x.lockedBalance > 1 && x.totalBalance < 10000 && x.totalBalance > 1000
	);

	const totalGt10000BondedGt1 = bondedButNotStaking.filter(
		(x) => x.lockedBalance > 1 && x.totalBalance > 10000
	);

	/////
	console.log(
		`Accounts with total balance >  1 DOT && total balance < ${(
			(1 / fiat) *
			1000
		).toFixed(2)} ${networkDenom} && bonded > 1: ${commaNumber(
			totalLt1000BondedGt1.length
		)} `
	);

	console.log(
		`Accounts with total balance >  ${((1 / fiat) * 1000).toFixed(
			2
		)} ${networkDenom} && total balance < ${((1 / fiat) * 10000).toFixed(
			2
		)} ${networkDenom} && bonded > 1: ${commaNumber(
			totalLt10000BondedGt1.length
		)} `
	);

	console.log(
		`Accounts with total balance > ${((1 / fiat) * 10000).toFixed(
			2
		)} ${networkDenom} && bonded > 1: ${commaNumber(
			totalGt10000BondedGt1.length
		)} `
	);

	console.log(
		`Accounts with total balance >  1 DOT && total balance < ${(
			(1 / fiat) *
			1000
		).toFixed(2)} ${networkDenom} && bonded > 1: ${(
			(totalLt1000BondedGt1.length /
				(accountsInfo.length - stakingAccounts.length)) *
			100
		).toFixed(2)} %`
	);

	console.log(
		`Accounts with total balance >  ${((1 / fiat) * 1000).toFixed(
			2
		)} ${networkDenom} && total balance < ${((1 / fiat) * 10000).toFixed(
			2
		)} ${networkDenom} && bonded > 1: ${(
			(totalLt10000BondedGt1.length /
				(accountsInfo.length - stakingAccounts.length)) *
			100
		).toFixed(2)} %`
	);

	console.log(
		`Accounts with total balance > ${((1 / fiat) * 10000).toFixed(
			2
		)} ${networkDenom} && bonded > 1: ${(
			(totalGt10000BondedGt1.length /
				(accountsInfo.length - stakingAccounts.length)) *
			100
		).toFixed(2)} %`
	);

	console.log("\n=========================");

	console.log("\nAccounts Staking Drilldown:");

	console.log(`Total Staking: ${commaNumber(stakingAccounts.length)}`);

	const validatorAccounts = stakingAccounts.filter((x) => x.isValidator);
	console.log(
		`Accounts run by validators:  ${commaNumber(validatorAccounts.length)}`
	);

	console.log(
		`Total accounts that are not run by validators:  ${commaNumber(
			stakingAccounts.length - validatorAccounts.length
		)}`
	);

	console.log(`Elected Nominators: ${commaNumber(activeNominators.length)}`);
	console.log(
		`OverSubscribed Nominators: ${commaNumber(overSubscribedNominators.length)}`
	);

	//

	// console.log(
	// 	"Accounts with free balance greater than 1 DOT and 0 bonded Amount: " +
	// 		freeBalanceGt1NolockedAmount.length
	// );

	// const freeBalanceFiatGt1000NolockedAmount = freeBalanceGt1NolockedAmount.filter(
	// 	(x) => x.freeBalanceFiat > 1000
	// );

	// console.log(
	// 	"Accounts with free balance greater than 1000 USD and 0 bonded Amount: " +
	// 		freeBalanceFiatGt1000NolockedAmount.length
	// );

	// const freeBalanceFiatGt10000NolockedAmount = freeBalanceGt1NolockedAmount.filter(
	// 	(x) => x.freeBalanceFiat > 10000
	// );

	// console.log(
	// 	"Accounts with free balance greater than 10000 USD and 0 bonded Amount: " +
	// 		freeBalanceFiatGt10000NolockedAmount.length
	// );

	// const bondedButNotNominating = accountsInfo.filter(
	// 	(x) => x.lockedBalance > 0 && x.isStaking == false
	// );
	// console.log(
	// 	"Accounts have bonded some funds but aren’t actively nominating: " +
	// 		bondedButNotNominating.length
	// );

	// const freeBalanceFiatGT1000bondedButNotNominating = bondedButNotNominating.filter(
	// 	(x) => x.freeBalanceFiat > 1000
	// );

	// console.log(
	// 	"Accounts have bonded some funds but aren’t actively nominating and wealth greater than 1000 USD: " +
	// 		freeBalanceFiatGT1000bondedButNotNominating.length
	// );

	// const freeBalanceFiatGT10000bondedButNotNominating = bondedButNotNominating.filter(
	// 	(x) => x.freeBalanceFiat > 10000
	// );

	// console.log(
	// 	"Accounts have bonded some funds but aren’t actively nominating and wealth greater than 10000 USD: " +
	// 		freeBalanceFiatGT10000bondedButNotNominating.length
	// );

	process.exit();
})();

const chunkArray = (array, size) => {
	const result = [];
	for (let i = 0; i < array.length; i += size) {
		const chunk = array.slice(i, i + size);
		result.push(chunk);
	}
	return result;
};

const fetchAccountStaking = async (accountId, api, validators) => {
	if (validators.includes(accountId)) {
		return true;
	}
	const staking = await api.query.staking.nominators(accountId);
	return !staking.isEmpty;
};

const fetchValidators = async (api) => {
	const validators = await api.query.staking.validators.keys();
	return getAccountId(validators);
};

const fetchValidatorsStakingInfo = async (api, validators) => {
	const chunkedStashes = chunkArray(validators, 100);
	const stakingInfo = [];
	const activeNominators = [];
	const overSubscribedNominators = [];

	const maxNominatorRewardedPerValidator = await api.consts.staking.maxNominatorRewardedPerValidator.toNumber();

	for (let i = 0; i < chunkedStashes.length; i++) {
		const info = await Promise.all(
			chunkedStashes[i].map((valId) => api.derive.staking.account(valId))
		);
		stakingInfo.push(...info);
	}
	stakingInfo.map((x) => {
		const nominators = x.exposure.others.map((nom) => {
			const stashtId = nom.who.toString();
			const stake = parseInt(nom.value);
			return { stashtId: stashtId, stake: stake };
		});
		activeNominators.push(...nominators);
		if (nominators.length > maxNominatorRewardedPerValidator) {
			const ascNom = nominators.sort(function (a, b) {
				return b.stake - a.stake;
			});
			const overSub = ascNom.slice(maxNominatorRewardedPerValidator);
			overSubscribedNominators.push(...overSub);
		}
	});
	return { activeNominators, overSubscribedNominators };
};

const getAccountId = (account) =>
	account
		.map((e) => e.args)
		.map(([e]) => e)
		.map((e) => e.toHuman());

function getSuffix() {
	if (network == "kusama") return "KSM";
	else return "DOT";
}
