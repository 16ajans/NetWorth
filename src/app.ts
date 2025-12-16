// SimpleFIN TypeScript Client
// Usage:
// 1. First time: npm run start <setup-token>
//    - This will save ACCESS_URL to .env automatically
// 2. Subsequent runs: npm run start
//    - Will read ACCESS_URL from .env

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

interface Organization {
    domain?: string;
    "sfin-url": string;
    name?: string;
    url?: string;
    id?: string;
}

interface Transaction {
    id: string;
    posted: number;
    amount: string;
    description: string;
    transacted_at?: number;
    pending?: boolean;
    extra?: Record<string, unknown>;
}

interface Account {
    org: Organization;
    id: string;
    name: string;
    currency: string;
    balance: string;
    "available-balance"?: string;
    "balance-date": number;
    transactions?: Transaction[];
    extra?: Record<string, unknown>;
}

interface AccountSet {
    errors: string[];
    accounts: Account[];
}

interface AccountsOptions {
    startDate?: number;
    endDate?: number;
    pending?: boolean;
    accountId?: string | string[];
    balancesOnly?: boolean;
}

class SimpleFinClient {
    private accessUrl: string;
    private baseUrl: string;
    private authHeader: string;

    constructor(accessUrl: string) {
        this.accessUrl = accessUrl;

        // Parse URL to extract credentials and base URL
        const url = new URL(accessUrl);
        const username = url.username;
        const password = url.password;

        // Remove credentials from URL
        url.username = '';
        url.password = '';
        this.baseUrl = url.toString().replace(/\/$/, ''); // Remove trailing slash

        // Create Basic Auth header
        const credentials = Buffer.from(`${username}:${password}`).toString('base64');
        this.authHeader = `Basic ${credentials}`;
    }

    /**
     * Claim an access URL from a setup token
     */
    static async claimToken(setupToken: string): Promise<string> {
        // Decode base64 token to get claim URL
        const claimUrl = Buffer.from(setupToken, "base64").toString("utf-8");
        console.log(`Claiming token from: ${claimUrl.replace(/\/\/.*@/, "//***@")}`);

        const response = await fetch(claimUrl, {
            method: "POST",
            headers: {
                "Content-Length": "0",
            },
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new Error("Token already claimed or invalid. It may have been compromised.");
            }
            throw new Error(`Failed to claim token: ${response.status} ${response.statusText}`);
        }

        const accessUrl = await response.text();
        console.log("✓ Access URL obtained successfully");
        return accessUrl;
    }

    /**
     * Fetch accounts and transactions
     */
    async fetchAccounts(options: AccountsOptions = {}): Promise<AccountSet> {
        const url = new URL(`${this.baseUrl}/accounts`);

        if (options.startDate) {
            url.searchParams.set("start-date", options.startDate.toString());
        }
        if (options.endDate) {
            url.searchParams.set("end-date", options.endDate.toString());
        }
        if (options.pending) {
            url.searchParams.set("pending", "1");
        }
        if (options.balancesOnly) {
            url.searchParams.set("balances-only", "1");
        }
        if (options.accountId) {
            const ids = Array.isArray(options.accountId) ? options.accountId : [options.accountId];
            ids.forEach(id => url.searchParams.append("account", id));
        }

        const response = await fetch(url.toString(), {
            headers: {
                'Authorization': this.authHeader,
            },
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new Error("Authentication failed. Access may have been revoked.");
            }
            if (response.status === 402) {
                throw new Error("Payment required to access this data.");
            }
            throw new Error(`Failed to fetch accounts: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as AccountSet;

        // Display any errors to the user
        if (data.errors && data.errors.length > 0) {
            console.warn("⚠️  Server errors:");
            data.errors.forEach(err => console.warn(`   ${err}`));
        }

        return data;
    }

    /**
     * Format account balance for display
     */
    static formatBalance(account: Account): string {
        const balance = parseFloat(account.balance);
        const formatted = new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: account.currency.startsWith("http") ? "USD" : account.currency,
        }).format(balance);

        if (account["available-balance"]) {
            const available = parseFloat(account["available-balance"]);
            const availFormatted = new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: account.currency.startsWith("http") ? "USD" : account.currency,
            }).format(available);
            return `${formatted} (${availFormatted} available)`;
        }

        return formatted;
    }

    /**
     * Format transaction for display
     */
    static formatTransaction(tx: Transaction): string {
        const date = new Date(tx.posted * 1000).toLocaleDateString();
        const amount = parseFloat(tx.amount);
        const sign = amount >= 0 ? "+" : "";
        const pending = tx.pending ? " [PENDING]" : "";
        return `${date}: ${sign}$${amount.toFixed(2)} - ${tx.description}${pending}`;
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    const envPath = join(process.cwd(), '.env');

    let accessUrl: string | undefined;

    // Try to read from .env first
    if (existsSync(envPath)) {
        try {
            const envContent = readFileSync(envPath, 'utf-8');
            const match = envContent.match(/ACCESS_URL=(.+)/);
            if (match?.[1]) {
                accessUrl = match[1].trim();
                console.log("✓ Found ACCESS_URL in .env file");
            }
        } catch (error) {
            console.warn("Warning: Could not read .env file", error);
        }
    }

    // If no access URL in .env and no token provided, show usage
    if (!accessUrl && args.length === 0) {
        console.log("SimpleFIN Client");
        console.log("\nUsage:");
        console.log("  First time setup:");
        console.log("    npm run start <setup-token>");
        console.log("    (This will save ACCESS_URL to .env automatically)");
        console.log("\n  Subsequent runs:");
        console.log("    npm run start");
        console.log("    (Reads ACCESS_URL from .env)");
        console.log("\nGet a setup token from: https://beta-bridge.simplefin.org/simplefin/create");
        process.exit(1);
    }

    // If token provided, claim it and save to .env
    if (args[0] && !accessUrl) {
        console.log("Claiming setup token...");
        accessUrl = await SimpleFinClient.claimToken(args[0]);
        console.log("✓ Access URL obtained successfully");

        // Save to .env
        try {
            let envContent = '';
            if (existsSync(envPath)) {
                envContent = readFileSync(envPath, 'utf-8');
                // Remove existing ACCESS_URL if present
                envContent = envContent.replace(/ACCESS_URL=.+\n?/g, '');
            }

            // Add new ACCESS_URL
            envContent += `ACCESS_URL=${accessUrl}\n`;
            writeFileSync(envPath, envContent, 'utf-8');
            console.log("✓ Access URL saved to .env file");
            console.log("\n⚠️  IMPORTANT: Keep your .env file secure and never commit it to version control!");
        } catch (error) {
            console.error("Error saving to .env:", error);
            console.log("\n⚠️  IMPORTANT: Save this access URL securely!");
            console.log(`Access URL: ${accessUrl}`);
        }
    }

    if (!accessUrl) {
        console.error("No access URL available");
        process.exit(1);
    }

    // Create client and fetch data
    const client = new SimpleFinClient(accessUrl);

    console.log("\nFetching account data...");
    const data = await client.fetchAccounts({
        balancesOnly: true, // We only need balances for net worth
    });

    // Calculate net worth
    let totalNetWorth = 0;
    const accountBalances: Array<{ name: string; balance: number; currency: string }> = [];

    data.accounts.forEach(account => {
        const balance = parseFloat(account.balance);

        // Only include standard currencies (skip custom currencies like reward points)
        if (!account.currency.startsWith('http')) {
            // TODO: For multi-currency support, you'd want to convert to a base currency
            // For now, we assume all accounts are in the same currency
            totalNetWorth += balance;
            accountBalances.push({
                name: account.name,
                balance: balance,
                currency: account.currency,
            });
        }
    });

    // Display results
    console.log(`\n${"=".repeat(60)}`);
    console.log("NET WORTH SUMMARY");
    console.log("=".repeat(60));

    if (accountBalances.length === 0) {
        console.log("\nNo accounts found.");
    } else {
        // Find the longest account name for proper alignment
        const maxNameLength = Math.max(...accountBalances.map(a => a.name.length));
        const nameColumnWidth = Math.max(maxNameLength, 20); // Minimum 20 chars

        console.log(`\nAccounts (${accountBalances.length}):\n`);

        accountBalances.forEach(account => {
            const formatted = new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: account.currency,
                signDisplay: "always",
            }).format(account.balance);

            console.log(`  ${account.name.padEnd(nameColumnWidth)} ${formatted.padStart(15)}`);
        });

        console.log(`\n${"-".repeat(nameColumnWidth + 17)}`);

        // Assuming all accounts are in the same currency for simplicity
        const currency = accountBalances[0]?.currency || "USD";
        const netWorthFormatted = new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: currency,
        }).format(totalNetWorth);

        console.log(`  ${"TOTAL NET WORTH".padEnd(nameColumnWidth)} ${netWorthFormatted.padStart(15)}`);
    }

    console.log(`\n${"=".repeat(60)}\n`);
}

// Run if this is the main module
import { fileURLToPath } from "url";
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
    main().catch(error => {
        console.error("Error:", error.message);
        process.exit(1);
    });
}

export { SimpleFinClient };
export type { Account, Transaction, AccountSet, AccountsOptions, Organization };