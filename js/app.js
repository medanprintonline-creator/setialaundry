// ========== KONFIGURASI SUPABASE ==========
const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_KEY = 'your-anon-key';
const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ========== GLOBAL VARIABEL ==========
let currentUser = null;
let currentMachine = null;
let ndefReader = null;
let isNFCSupported = false;

// ========== LOGIN ==========
async function handleLogin(event) {
    event.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    showLoading('Memeriksa kredensial...');
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const { data: userData, error: userError } = await supabase
            .from('app_users')
            .select('*')
            .eq('email', email)
            .single();
        if (userError) throw userError;
        if (!userData.is_active) throw new Error('Akun tidak aktif');
        currentUser = userData;
        await supabase.from('app_users').update({ last_login: new Date() }).eq('id', currentUser.id);
        document.getElementById('loginPage').classList.add('hidden');
        document.getElementById('mainApp').classList.remove('hidden');
        document.getElementById('userName').innerText = currentUser.full_name;
        document.getElementById('userRole').innerText = currentUser.role === 'admin' ? 'Admin' : 'Kasir';
        hideLoading();
        showToast(`Login berhasil, ${currentUser.full_name}`, 'success');
        checkNFCSupport();
    } catch (error) {
        hideLoading();
        showToast('Login gagal: ' + error.message, 'error');
    }
}

async function logout() {
    await supabase.auth.signOut();
    location.reload();
}

// ========== NFC ==========
async function checkNFCSupport() {
    if ('NDEFReader' in window) {
        isNFCSupported = true;
        updateNFCStatus(true, 'NFC tersedia. Tap kartu mesin.');
        initNFCReader();
    } else {
        updateNFCStatus(false, 'Browser tidak mendukung NFC. Gunakan Chrome for Android dengan NFC aktif.');
    }
}

async function initNFCReader() {
    try {
        ndefReader = new NDEFReader();
        await ndefReader.scan();
        ndefReader.addEventListener("reading", ({ message, serialNumber }) => {
            handleNFCRead(message, serialNumber);
        });
        updateNFCStatus(true, '✓ Siap membaca kartu.');
    } catch (error) {
        updateNFCStatus(false, 'Gagal akses NFC: ' + error.message);
    }
}

function scanNFC() {
    if (!isNFCSupported) showToast('NFC tidak didukung', 'error');
    else showToast('Tempelkan kartu mesin ke HP', 'info');
}

async function handleNFCRead(message, serialNumber) {
    showLoading('Membaca kartu...');
    try {
        // Baca saldo dari kartu (NDEF record)
        let cardBalance = 0;
        for (const record of message.records) {
            if (record.recordType === "text") {
                const decoder = new TextDecoder(record.encoding);
                const data = JSON.parse(decoder.decode(record.data));
                cardBalance = data.balance || 0;
                break;
            }
        }
        const { data: machine, error } = await supabase
            .from('machines')
            .select('*')
            .eq('uid_card', serialNumber)
            .single();
        if (error && error.code === 'PGRST116') {
            hideLoading();
            registerNewMachine(serialNumber, cardBalance);
            return;
        }
        if (error) throw error;
        if (machine.balance !== cardBalance) {
            await supabase.from('machines').update({ balance: cardBalance }).eq('id', machine.id);
            machine.balance = cardBalance;
        }
        currentMachine = machine;
        displayMachineInfo(machine);
        hideLoading();
        playBeep();
        showToast(`Mesin: ${machine.name}`, 'success');
    } catch (error) {
        hideLoading();
        showToast('Gagal baca kartu: ' + error.message, 'error');
    }
}

function registerNewMachine(uid, balance) {
    const name = prompt('Kartu mesin belum terdaftar. Masukkan nama mesin (contoh: Washer 1):', '');
    if (!name) return;
    let type = '';
    while (type !== 'washer' && type !== 'dryer') {
        type = prompt('Tipe mesin (washer / dryer):', '').toLowerCase();
        if (type !== 'washer' && type !== 'dryer') alert('Tipe harus washer atau dryer');
    }
    showLoading('Mendaftarkan mesin...');
    supabase.from('machines').insert({
        uid_card: uid,
        name: name,
        type: type,
        balance: balance
    }).select().single().then(({ data, error }) => {
        if (error) throw error;
        currentMachine = data;
        displayMachineInfo(data);
        hideLoading();
        showToast(`Mesin ${name} berhasil didaftarkan`, 'success');
    }).catch(err => {
        hideLoading();
        showToast('Gagal registrasi: ' + err.message, 'error');
    });
}

function displayMachineInfo(machine) {
    document.getElementById('machineUID').innerText = machine.uid_card;
    document.getElementById('machineName').innerText = machine.name;
    document.getElementById('machineType').innerText = machine.type === 'washer' ? 'Mesin Cuci' : 'Pengering';
    const price = machine.type === 'washer' ? 10000 : 8000;
    document.getElementById('machinePrice').innerHTML = `Rp ${price.toLocaleString()}`;
    document.getElementById('machineBalance').innerHTML = formatRupiah(machine.balance);
    document.getElementById('machineSection').classList.remove('hidden');
    document.getElementById('historySection').classList.remove('hidden');
    loadHistory('topup');
}

function showTopupForm() {
    document.getElementById('topupForm').classList.remove('hidden');
}
function hideTopupForm() {
    document.getElementById('topupForm').classList.add('hidden');
    document.getElementById('topupAmountInput').value = '';
}
function setTopupAmount(amount) {
    document.getElementById('topupAmountInput').value = amount;
}

async function processTopup() {
    if (!currentMachine) return;
    let amount = parseInt(document.getElementById('topupAmountInput').value);
    if (isNaN(amount) || amount < 1000) {
        showToast('Minimal top up Rp 1.000', 'error');
        return;
    }
    if (amount > 250000) {
        showToast('Maksimal top up Rp 250.000', 'error');
        return;
    }
    const newBalance = currentMachine.balance + amount;
    const newBalanceDigit = newBalance / 1000;
    if (newBalanceDigit > 250) {
        showToast('Saldo maksimal Rp 250.000', 'error');
        return;
    }
    showLoading('Memproses top up...');
    try {
        const { error: updateError } = await supabase
            .from('machines')
            .update({ balance: newBalance })
            .eq('id', currentMachine.id);
        if (updateError) throw updateError;
        const { error: transError } = await supabase
            .from('transactions_topup')
            .insert({
                machine_id: currentMachine.id,
                amount: amount,
                old_balance: currentMachine.balance,
                new_balance: newBalance,
                cashier_id: currentUser.id
            });
        if (transError) throw transError;
        await updateCardBalance(currentMachine.uid_card, newBalance);
        currentMachine.balance = newBalance;
        document.getElementById('machineBalance').innerHTML = formatRupiah(newBalance);
        hideTopupForm();
        hideLoading();
        playSuccessBeep();
        showToast(`Top up Rp ${formatRupiah(amount)} berhasil!`, 'success');
        loadHistory('topup');
    } catch (error) {
        hideLoading();
        showToast('Gagal top up: ' + error.message, 'error');
    }
}

async function recordUsage() {
    if (!currentMachine) return;
    const price = currentMachine.type === 'washer' ? 10000 : 8000;
    if (currentMachine.balance < price) {
        showToast(`Saldo tidak cukup! Dibutuhkan Rp ${price.toLocaleString()}`, 'error');
        return;
    }
    const newBalance = currentMachine.balance - price;
    showLoading('Mencatat penggunaan...');
    try {
        const { error: updateError } = await supabase
            .from('machines')
            .update({ balance: newBalance })
            .eq('id', currentMachine.id);
        if (updateError) throw updateError;
        const { error: usageError } = await supabase
            .from('transactions_usage')
            .insert({
                machine_id: currentMachine.id,
                amount: price,
                balance_before: currentMachine.balance,
                balance_after: newBalance,
                cashier_id: currentUser.id
            });
        if (usageError) throw usageError;
        await updateCardBalance(currentMachine.uid_card, newBalance);
        currentMachine.balance = newBalance;
        document.getElementById('machineBalance').innerHTML = formatRupiah(newBalance);
        hideLoading();
        playSuccessBeep();
        showToast(`Penggunaan ${currentMachine.name} (Rp ${price.toLocaleString()}) berhasil dicatat`, 'success');
        loadHistory('usage');
    } catch (error) {
        hideLoading();
        showToast('Gagal mencatat penggunaan: ' + error.message, 'error');
    }
}

async function updateCardBalance(uid, newBalance) {
    try {
        const cardData = { uid, balance: newBalance, updated: new Date().toISOString() };
        const encoder = new TextEncoder();
        const record = { recordType: "text", data: encoder.encode(JSON.stringify(cardData)) };
        const writer = new NDEFWriter();
        await writer.write(record);
    } catch (error) {
        throw new Error('Gagal menulis ke kartu. Pastikan kartu masih dalam jangkauan.');
    }
}

let currentHistoryType = 'topup';
async function loadHistory(type = currentHistoryType) {
    if (!currentMachine) return;
    currentHistoryType = type;
    const table = type === 'topup' ? 'transactions_topup' : 'transactions_usage';
    const { data, error } = await supabase
        .from(table)
        .select('*')
        .eq('machine_id', currentMachine.id)
        .order('created_at', { ascending: false })
        .limit(20);
    if (error) {
        console.error(error);
        return;
    }
    const container = document.getElementById('historyList');
    if (!data || data.length === 0) {
        container.innerHTML = `<div class="p-6 text-center text-gray-500"><i class="fas fa-inbox text-3xl mb-2"></i><p>Belum ada riwayat ${type === 'topup' ? 'top up' : 'penggunaan'}</p></div>`;
        return;
    }
    container.innerHTML = data.map(item => {
        const date = new Date(item.created_at);
        const formattedDate = date.toLocaleString('id-ID');
        if (type === 'topup') {
            return `
                <div class="p-4 hover:bg-gray-50">
                    <div class="flex justify-between">
                        <div>
                            <p class="font-semibold text-green-600">+ ${formatRupiah(item.amount)}</p>
                            <p class="text-xs text-gray-500">${formattedDate}</p>
                        </div>
                        <div class="text-right">
                            <p class="text-sm">Saldo sebelum: ${formatRupiah(item.old_balance)}</p>
                            <p class="text-sm font-semibold">Saldo setelah: ${formatRupiah(item.new_balance)}</p>
                        </div>
                    </div>
                </div>
            `;
        } else {
            return `
                <div class="p-4 hover:bg-gray-50">
                    <div class="flex justify-between">
                        <div>
                            <p class="font-semibold text-red-600">- ${formatRupiah(item.amount)}</p>
                            <p class="text-xs text-gray-500">${formattedDate}</p>
                        </div>
                        <div class="text-right">
                            <p class="text-sm">Saldo sebelum: ${formatRupiah(item.balance_before)}</p>
                            <p class="text-sm font-semibold">Saldo setelah: ${formatRupiah(item.balance_after)}</p>
                        </div>
                    </div>
                </div>
            `;
        }
    }).join('');
}

function showHistory(type) {
    const btnTopup = document.querySelector('#historySection button:first-child');
    const btnUsage = document.querySelector('#historySection button:last-child');
    if (type === 'topup') {
        btnTopup.classList.add('bg-blue-100', 'text-blue-700');
        btnTopup.classList.remove('bg-gray-100', 'text-gray-700');
        btnUsage.classList.add('bg-gray-100', 'text-gray-700');
        btnUsage.classList.remove('bg-blue-100', 'text-blue-700');
    } else
