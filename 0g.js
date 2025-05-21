require('dotenv').config();
const ethers = require('ethers');
const fs = require('fs');
const yargs = require('yargs');
const inquirer = require('inquirer');
const ora = require('ora');

// Baca konfigurasi dari config.json
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const RPC_URL = config.rpcUrl;
const CHAIN_ID = config.chainId;
const DEFAULT_CYCLE_COUNT = config.cycleCount;
const ENABLE_TOKEN_RECOVERY = config.enableTokenRecovery;

// Parsing argumen command-line
const argv = yargs
  .option('cycles', {
    type: 'number',
    description: 'Jumlah siklus untuk dijalankan',
  })
  .option('daily', {
    type: 'boolean',
    description: 'Jalankan 3 siklus setiap 24 jam',
  })
  .help().argv;

// Alamat kontrak
const BTC_TOKEN_ADDRESS = '0x36f6414FF1df609214dDAbA71c84f18bcf00F67d';
const ETH_TOKEN_ADDRESS = '0x0fE9B43625fA7EdD663aDcEC0728DD635e4AbF7c';
const USDT_TOKEN_ADDRESS = '0x3ec8a8705be1d5ca90066b37ba62c4183b024ebf';
const ROUTER_ADDRESS = '0xb95B5953FF8ee5D5d9818CdbEfE363ff2191318c';

// ABI untuk fungsi approve (ERC-20) dan swap (Router)
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function decimals() public view returns (uint8)',
  'function balanceOf(address account) public view returns (uint256)',
];
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut)',
];

// Inisialisasi provider dan wallet
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Daftar token dan pasangan swap
const tokens = [
  { address: BTC_TOKEN_ADDRESS, name: 'BTC', decimals: 18, swapRange: [0.001, 0.015], formatDecimals: 6 },
  { address: ETH_TOKEN_ADDRESS, name: 'ETH', decimals: 18, swapRange: [0.01, 0.1], formatDecimals: 4 },
  { address: USDT_TOKEN_ADDRESS, name: 'USDT', decimals: 18, swapRange: [60, 400], formatDecimals: 2 },
];
const allowedPairs = [
  { tokenIn: BTC_TOKEN_ADDRESS, tokenOut: USDT_TOKEN_ADDRESS, inName: 'BTC', outName: 'USDT' },
  { tokenIn: BTC_TOKEN_ADDRESS, tokenOut: ETH_TOKEN_ADDRESS, inName: 'BTC', outName: 'ETH' },
  { tokenIn: USDT_TOKEN_ADDRESS, tokenOut: ETH_TOKEN_ADDRESS, inName: 'USDT', outName: 'ETH' },
  { tokenIn: USDT_TOKEN_ADDRESS, tokenOut: BTC_TOKEN_ADDRESS, inName: 'USDT', outName: 'BTC' },
  { tokenIn: ETH_TOKEN_ADDRESS, tokenOut: USDT_TOKEN_ADDRESS, inName: 'ETH', outName: 'USDT' },
];

// Inisialisasi kontrak untuk setiap token
const tokenContracts = {};
tokens.forEach((token) => {
  tokenContracts[token.address] = new ethers.Contract(token.address, ERC20_ABI, wallet);
});
const routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);

// Fungsi untuk mendapatkan nonce dinamis
async function getNonce() {
  return await wallet.getTransactionCount('pending');
}

// Fungsi untuk mendapatkan gas price dinamis
async function getGasPrice() {
  return await provider.getGasPrice();
}

// Fungsi untuk menghitung gas limit dinamis
async function estimateGas(tx) {
  try {
    return await provider.estimateGas(tx);
  } catch (error) {
    console.error('⚠️ Error estimasi gas:', error.message);
    return ethers.BigNumber.from('100000'); // Fallback gas limit
  }
}

// Fungsi untuk approve token
async function approveToken(tokenAddress, tokenName) {
  const spinner = ora(`Memproses approve untuk ${tokenName}...`).start();
  const contract = tokenContracts[tokenAddress];
  try {
    const allowance = await contract.allowance(wallet.address, ROUTER_ADDRESS);
    const maxAllowance = ethers.constants.MaxUint256;
    const decimals = await contract.decimals();

    if (allowance.gte(ethers.utils.parseUnits('1000000', decimals))) {
      spinner.succeed(`Allowance ${tokenName} sudah cukup.`);
      return true;
    }

    const gasPrice = await getGasPrice();
    const nonce = await getNonce();
    const tx = await contract.approve(ROUTER_ADDRESS, maxAllowance, {
      gasPrice,
      nonce,
    });
    spinner.text = `Menunggu konfirmasi approve ${tokenName} (Tx: ${tx.hash})...`;
    await tx.wait();
    spinner.succeed(`Approve ${tokenName} berhasil!`);
    return true;
  } catch (error) {
    spinner.fail(`Error saat approve ${tokenName}: ${error.message}`);
    return false;
  }
}

// Fungsi untuk mendapatkan jumlah swap acak
function getRandomAmount(tokenAddress) {
  const token = tokens.find((t) => t.address === tokenAddress);
  const [min, max] = token.swapRange;
  const random = (Math.random() * (max - min) + min).toFixed(token.formatDecimals);
  return ethers.utils.parseUnits(random, token.decimals);
}

// Fungsi untuk format jumlah token
function formatAmount(amount, tokenAddress) {
  const token = tokens.find((t) => t.address === tokenAddress);
  return Number(ethers.utils.formatUnits(amount, token.decimals)).toFixed(token.formatDecimals);
}

// Fungsi untuk memilih pasangan acak
function getRandomPair() {
  const index = Math.floor(Math.random() * allowedPairs.length);
  return allowedPairs[index];
}

// Fungsi untuk mencari pasangan yang menghasilkan token tertentu
async function recoverToken(tokenAddress, maxRetries = 5) {
  if (!ENABLE_TOKEN_RECOVERY) {
    console.log(`⚠️ Recovery token ${tokens.find((t) => t.address === tokenAddress).name} tidak diaktifkan.`);
    return false;
  }

  const spinner = ora(`Mencoba mendapatkan ${tokens.find((t) => t.address === tokenAddress).name}...`).start();
  const recoveryPairs = allowedPairs.filter((pair) => pair.tokenOut === tokenAddress);
  const shuffledRecoveryPairs = recoveryPairs.sort(() => Math.random() - 0.5);

  for (const pair of shuffledRecoveryPairs) {
    const tokenContract = tokenContracts[pair.tokenIn];
    const balance = await tokenContract.balanceOf(wallet.address);
    const amountIn = getRandomAmount(pair.tokenIn);

    if (balance.gte(amountIn)) {
      spinner.text = `Mencoba swap ${pair.inName} -> ${pair.outName} untuk mendapatkan ${pair.outName}`;
      const success = await swapToken(pair, maxRetries);
      if (success) {
        spinner.succeed(`Berhasil mendapatkan ${pair.outName} melalui swap!`);
        return true;
      }
    } else {
      spinner.warn(`Saldo ${pair.inName} tidak cukup untuk recovery.`);
    }
  }

  spinner.fail(`Tidak bisa mendapatkan ${tokens.find((t) => t.address === tokenAddress).name} melalui swap.`);
  return false;
}

// Fungsi untuk melakukan swap dengan retry
async function swapToken(pair, maxRetries = 5) {
  const { tokenIn, tokenOut, inName, outName } = pair;
  let attempt = 1;

  while (attempt <= maxRetries) {
    const spinner = ora(`Percobaan ${attempt} untuk swap ${inName} -> ${outName}`).start();
    try {
      // Cek saldo
      const tokenContract = tokenContracts[tokenIn];
      const balance = await tokenContract.balanceOf(wallet.address);
      const amountIn = getRandomAmount(tokenIn);
      if (balance.lt(amountIn)) {
        spinner.warn(`Saldo ${inName} tidak cukup: ${formatAmount(balance, tokenIn)} tersedia, ${formatAmount(amountIn, tokenIn)} dibutuhkan.`);
        if (ENABLE_TOKEN_RECOVERY) {
          const recovered = await recoverToken(tokenIn, maxRetries);
          if (recovered) {
            spinner.text = `Mencoba swap ${inName} -> ${outName} lagi setelah recovery`;
            continue; // Coba lagi setelah recovery
          }
        }
        spinner.fail(`Melewati swap ${inName} -> ${outName}.`);
        return false;
      }

      // Parameter swap
      const fee = inName === 'USDT' ? 100 : 500; // Fee 0.01% untuk USDT, 0.05% untuk lainnya
      const recipient = wallet.address;
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 menit
      const amountOutMinimum = 0; // Placeholder
      const sqrtPriceLimitX96 = 0;

      const params = {
        tokenIn,
        tokenOut,
        fee,
        recipient,
        deadline,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96,
      };

      // Tampilan detail
      const amountInFormatted = formatAmount(amountIn, tokenIn);
      console.log(` || ${amountInFormatted} ${inName} -> ${outName}`);
      console.log(`  - Fee: ${fee / 10000}%`);
      console.log(`  - Recipient: ${recipient}`);

      // Estimasi gas
      const gasPrice = await getGasPrice();
      const nonce = await getNonce();
      const txData = routerContract.interface.encodeFunctionData('exactInputSingle', [params]);
      const tx = {
        to: ROUTER_ADDRESS,
        data: txData,
        gasPrice,
        nonce,
        from: wallet.address,
      };
      const gasLimit = await estimateGas(tx);

      // Kirim transaksi swap
      spinner.text = `Menunggu konfirmasi swap ${inName} -> ${outName}...`;
      const swapTx = await routerContract.exactInputSingle(params, {
        gasPrice,
        gasLimit,
        nonce,
      });
      console.log(`Swap ${inName} -> ${outName}: ${swapTx.hash}`);
      await swapTx.wait();
      spinner.succeed(`Swap ${inName} -> ${outName} berhasil! 🎉`);
      return true;
    } catch (error) {
      spinner.fail(`Gagal percobaan ${attempt} untuk ${inName} -> ${outName}`);
      if (attempt === maxRetries) {
        spinner.fail(`Gagal setelah ${maxRetries} percobaan, lanjut ke pasangan berikutnya.`);
        return false;
      }
      spinner.text = `Menunggu 5 detik sebelum retry...`;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      attempt++;
    }
  }
  return false;
}

// Fungsi untuk menjalankan satu siklus swap
async function runCycle(cycle, totalCycles) {
  console.log(`\n🌟 Siklus ${cycle} dari ${totalCycles} 🚀`);
  console.log('───────────────────────────');

  // Approve semua token
  console.log('📋 Memulai Approve Token');
  for (const token of tokens) {
    const success = await approveToken(token.address, token.name);
    if (!success) {
      console.log(`⚠️ Lanjut meskipun approve ${token.name} gagal.`);
    }
  }

  // Lakukan swap untuk semua pasangan secara acak
  console.log('\n📋 Memulai Swap');
  console.log('───────────────────────────');
  const pairCount = allowedPairs.length;
  const attemptedPairs = new Set();
  while (attemptedPairs.size < pairCount) {
    const pair = getRandomPair();
    if (attemptedPairs.has(pair.inName + '-' + pair.outName)) continue;
    attemptedPairs.add(pair.inName + '-' + pair.outName);

    const success = await swapToken(pair);
    if (success) {
      const spinner = ora('Jeda 10 detik sebelum swap berikutnya... ⏳').start();
      await new Promise((resolve) => setTimeout(resolve, 10000));
      spinner.succeed('Lanjut ke swap berikutnya! ➡️');
    }
  }
}

// Fungsi untuk memilih mode siklus
async function selectCycleMode() {
  if (argv.daily) {
    return { mode: 'daily' };
  }
  if (argv.cycles) {
    return { mode: 'manual', cycles: argv.cycles };
  }

  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'Pilih mode siklus:',
      choices: [
        'Manual (tentukan jumlah siklus)',
        'Daily (3 siklus setiap 24 jam)',
      ],
    },
  ]);

  if (mode.includes('Manual')) {
    const { cycles } = await inquirer.prompt([
      {
        type: 'number',
        name: 'cycles',
        message: 'Masukkan jumlah siklus:',
        default: DEFAULT_CYCLE_COUNT,
        validate: (input) => input > 0 || 'Jumlah siklus harus lebih dari 0.',
      },
    ]);
    return { mode: 'manual', cycles };
  }
  return { mode: 'daily' };
}

// Fungsi utama
async function main() {
  console.log('\n🚀 AutoSwap Dimulai! 🚀');
  console.log(`Wallet: ${wallet.address}`);
  console.log(`Network: Chain ID ${CHAIN_ID}`);
  console.log(`Token Recovery: ${ENABLE_TOKEN_RECOVERY ? 'Enabled' : 'Disabled'}`);
  console.log('═══════════════════════════════════════\n');

  try {
    const { mode, cycles } = await selectCycleMode();

    if (mode === 'daily') {
      console.log('🕒 Mode Daily: Menjalankan 3 siklus setiap 24 jam');
      const runDaily = async () => {
        console.log(`\n📅 Siklus harian dimulai pada ${new Date().toLocaleString()}`);
        for (let cycle = 1; cycle <= 3; cycle++) {
          await runCycle(cycle, 3);
        }
        console.log('⏳ Menunggu 24 jam untuk siklus harian berikutnya...');
      };

      await runDaily();
      setInterval(runDaily, 24 * 60 * 60 * 1000); // Ulangi setiap 24 jam
    } else {
      console.log(`Siklus: ${cycles}`);
      console.log('═══════════════════════════════════════\n');
      for (let cycle = 1; cycle <= cycles; cycle++) {
        await runCycle(cycle, cycles);
      }
      console.log('\n🎉 AutoSwap Selesai! 🎉');
    }
  } catch (error) {
    console.error(`❌ Error di main: ${error.message}`);
  }
}

// Jalankan program
main();