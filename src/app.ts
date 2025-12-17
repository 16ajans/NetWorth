// SimpleFIN Net Worth HTTP Server
// Usage:
// 1. First time: node dist/server.js setup <setup-token>
// 2. Start server: node dist/server.js
// 3. Or with pm2: pm2 start dist/server.js --name networth

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface Organization {
    domain?: string;
    "sfin-url": string;
    name?: string;
    url?: string;
    id?: string;
}

interface Account {
    org: Organization;
    id: string;
    name: string;
    currency: string;
    balance: string;
    "available-balance"?: string;
    "balance-date": number;
    extra?: Record<string, unknown>;
}

interface AccountSet {
    errors: string[];
    accounts: Account[];
}

interface NetWorthCache {
    netWorth: number;
    currency: string;
    lastUpdated: number;
    accounts: Array<{ name: string; balance: number }>;
    errors: string[];
}

interface NetWorthHistoryEntry {
    timestamp: number;
    date: string;
    netWorth: number;
    currency: string;
    accountCount: number;
}

class SimpleFinClient {
    private baseUrl: string;
    private authHeader: string;

    constructor(accessUrl: string) {
        const url = new URL(accessUrl);
        const username = url.username;
        const password = url.password;

        url.username = '';
        url.password = '';
        this.baseUrl = url.toString().replace(/\/$/, '');

        const credentials = Buffer.from(`${username}:${password}`).toString('base64');
        this.authHeader = `Basic ${credentials}`;
    }

    static async claimToken(setupToken: string): Promise<string> {
        const claimUrl = Buffer.from(setupToken, "base64").toString("utf-8");
        console.log(`Claiming token from: ${claimUrl.replace(/\/\/.*@/, "//***@")}`);

        const response = await fetch(claimUrl, {
            method: "POST",
            headers: { "Content-Length": "0" },
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new Error(
                    "Failed to claim token (403 Forbidden). " +
                    "This token may have already been claimed by someone else, or it has expired. " +
                    "If you did not claim this token, it may be compromised. " +
                    "Please generate a new token from SimpleFIN and disable the old one if possible."
                );
            }
            throw new Error(`Failed to claim token: ${response.status}`);
        }

        return await response.text();
    }

    async fetchAccounts(): Promise<AccountSet> {
        const url = `${this.baseUrl}/accounts?balances-only=1`;

        const response = await fetch(url, {
            headers: { 'Authorization': this.authHeader },
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new Error("Authentication failed. Access may have been revoked.");
            }
            if (response.status === 402) {
                throw new Error("Payment required.");
            }
            throw new Error(`Failed to fetch accounts: ${response.status}`);
        }

        return await response.json() as AccountSet;
    }

    async calculateNetWorth(): Promise<NetWorthCache> {
        const data = await this.fetchAccounts();

        let totalNetWorth = 0;
        const accounts: Array<{ name: string; balance: number }> = [];
        let currency = "USD";

        data.accounts.forEach(account => {
            const balance = parseFloat(account.balance);

            if (!account.currency.startsWith('http')) {
                totalNetWorth += balance;
                accounts.push({ name: account.name, balance });
                currency = account.currency;
            }
        });

        // Sanitize error messages from SimpleFIN
        const sanitizedErrors = data.errors.map(err => this.sanitizeErrorMessage(err));

        return {
            netWorth: totalNetWorth,
            currency,
            lastUpdated: Date.now(),
            accounts,
            errors: sanitizedErrors,
        };
    }

    /**
     * Sanitize error messages to prevent XSS and injection attacks
     * Removes HTML tags, limits length, and escapes special characters
     */
    private sanitizeErrorMessage(message: string): string {
        // Remove any HTML tags
        let sanitized = message.replace(/<[^>]*>/g, '');

        // Limit length to prevent excessive data
        if (sanitized.length > 500) {
            sanitized = sanitized.substring(0, 500) + '...';
        }

        // Escape special characters for safe display
        sanitized = sanitized
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');

        return sanitized;
    }
}

class NetWorthServer {
    private client: SimpleFinClient | null = null;
    private cache: NetWorthCache | null = null;
    private refreshInterval: NodeJS.Timeout | null = null;
    private readonly CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 hours
    private readonly PORT: number;
    private readonly HISTORY_FILE: string;

    constructor(port: number = 3000) {
        this.PORT = port;
        this.HISTORY_FILE = join(process.cwd(), 'data', 'networth-history.json');

        // Ensure data directory exists
        const dataDir = join(process.cwd(), 'data');
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }
    }

    async initialize(accessUrl: string) {
        this.client = new SimpleFinClient(accessUrl);

        // Initial fetch
        await this.refreshNetWorth();

        // Set up automatic refresh every 4 hours
        this.refreshInterval = setInterval(() => {
            this.refreshNetWorth().catch(err => {
                console.error('Error refreshing net worth:', err.message);
            });
        }, this.CACHE_DURATION);

        console.log(`✓ Net worth cache initialized`);
        console.log(`✓ Auto-refresh enabled (every 4 hours)`);
    }

    private async refreshNetWorth(): Promise<void> {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        console.log('Fetching net worth from SimpleFIN...');
        this.cache = await this.client.calculateNetWorth();
        console.log(`✓ Net worth updated: ${this.formatCurrency(this.cache.netWorth, this.cache.currency)}`);

        // Log any errors from SimpleFIN to stderr (PM2 will capture)
        if (this.cache.errors.length > 0) {
            console.error('⚠️  SimpleFIN warnings:');
            this.cache.errors.forEach(err => console.error(`   ${err}`));
        }

        // Save to history
        this.saveToHistory(this.cache);
    }

    private saveToHistory(cache: NetWorthCache): void {
        try {
            // Read existing history
            let history: NetWorthHistoryEntry[] = [];
            if (existsSync(this.HISTORY_FILE)) {
                const data = readFileSync(this.HISTORY_FILE, 'utf-8');
                history = JSON.parse(data);
            }

            // Add new entry
            const entry: NetWorthHistoryEntry = {
                timestamp: cache.lastUpdated,
                date: new Date(cache.lastUpdated).toISOString(),
                netWorth: cache.netWorth,
                currency: cache.currency,
                accountCount: cache.accounts.length,
            };

            history.push(entry);

            // Write back to file
            writeFileSync(this.HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
            console.log(`✓ Net worth logged to history (${history.length} entries total)`);
        } catch (error) {
            console.error('Failed to save net worth history:', error);
        }
    }

    private formatCurrency(amount: number, currency: string): string {
        return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: currency,
        }).format(amount);
    }

    private handleRequest(req: IncomingMessage, res: ServerResponse): void {
        const url = req.url || '/';

        // Health check endpoint
        if (url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }

        // Net worth endpoint - returns raw number as plain text
        if (url === '/networth' || url === '/') {
            if (!this.cache) {
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                res.end('Service unavailable');
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(this.cache.netWorth.toFixed(2));
            return;
        }

        // 30-day change endpoint - returns change as plain text
        if (url === '/networth/change' || url === '/change') {
            const change = this.calculateChange30Days();

            if (change === null) {
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                res.end('Insufficient data');
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(change.toFixed(2));
            return;
        }

        // Detailed endpoint with JSON
        if (url === '/networth/details') {
            if (!this.cache) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Net worth data not available yet' }));
                return;
            }

            const change30d = this.calculateChange30Days();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                netWorth: this.cache.netWorth,
                currency: this.cache.currency,
                formatted: this.formatCurrency(this.cache.netWorth, this.cache.currency),
                lastUpdated: new Date(this.cache.lastUpdated).toISOString(),
                accountCount: this.cache.accounts.length,
                change30Days: change30d,
                change30DaysFormatted: change30d !== null ? this.formatCurrency(change30d, this.cache.currency) : null,
            }));
            return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }

    private calculateChange30Days(): number | null {
        if (!this.cache) return null;

        try {
            // Read history
            if (!existsSync(this.HISTORY_FILE)) {
                return null;
            }

            const data = readFileSync(this.HISTORY_FILE, 'utf-8');
            const history: NetWorthHistoryEntry[] = JSON.parse(data);

            if (history.length === 0) {
                return null;
            }

            // Find entry closest to 30 days ago
            const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

            // Filter entries that are at least 30 days old
            const oldEntries = history.filter(entry => entry.timestamp <= thirtyDaysAgo);

            if (oldEntries.length === 0) {
                // Not enough data yet
                return null;
            }

            // Get the most recent entry from 30+ days ago
            const oldEntry = oldEntries[oldEntries.length - 1];

            if (!oldEntry) {
                return null;
            }

            // Calculate change
            const change = this.cache.netWorth - oldEntry.netWorth;
            return change;

        } catch (error) {
            console.error('Error calculating 30-day change:', error);
            return null;
        }
    }

    start(): void {
        const server = createServer((req, res) => {
            // CORS headers for reverse proxy compatibility
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            this.handleRequest(req, res);
        });

        server.listen(this.PORT, () => {
            console.log(`\n${"=".repeat(60)}`);
            console.log(`Net Worth Server Running`);
            console.log("=".repeat(60));
            console.log(`\n  Endpoints:`);
            console.log(`    http://localhost:${this.PORT}/              - Raw net worth (text)`);
            console.log(`    http://localhost:${this.PORT}/networth      - Raw net worth (text)`);
            console.log(`    http://localhost:${this.PORT}/change        - 30-day change (text)`);
            console.log(`    http://localhost:${this.PORT}/networth/details - JSON with metadata`);
            console.log(`    http://localhost:${this.PORT}/health        - Health check`);
            console.log(`\n  Cache refresh: Every 4 hours`);
            console.log(`  Last updated: ${this.cache ? new Date(this.cache.lastUpdated).toLocaleString() : 'Not yet fetched'}`);
            console.log(`\n${"=".repeat(60)}\n`);
        });

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('\nShutting down gracefully...');
            if (this.refreshInterval) {
                clearInterval(this.refreshInterval);
            }
            server.close(() => {
                console.log('Server closed');
                process.exit(0);
            });
        });
    }

    stop(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    const envPath = join(process.cwd(), '.env');

    // Setup mode
    if (args[0] === 'setup') {
        if (!args[1]) {
            console.error('Usage: node dist/server.js setup <setup-token>');
            process.exit(1);
        }

        console.log('Setting up SimpleFIN access...');
        const accessUrl = await SimpleFinClient.claimToken(args[1]);
        console.log('✓ Access URL obtained');

        let envContent = '';
        if (existsSync(envPath)) {
            envContent = readFileSync(envPath, 'utf-8');
            envContent = envContent.replace(/ACCESS_URL=.+\n?/g, '');
        }

        envContent += `ACCESS_URL=${accessUrl}\n`;
        writeFileSync(envPath, envContent, 'utf-8');
        console.log('✓ Saved to .env file');
        console.log('\nNow start the server with: node dist/server.js');
        return;
    }

    // Server mode
    let accessUrl: string | undefined;

    if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf-8');
        const match = envContent.match(/ACCESS_URL=(.+)/);
        if (match?.[1]) {
            accessUrl = match[1].trim();
        }
    }

    if (!accessUrl) {
        console.error('No ACCESS_URL found in .env file');
        console.error('\nRun setup first: node dist/server.js setup <setup-token>');
        console.error('Get a token from: https://beta-bridge.simplefin.org/simplefin/create');
        process.exit(1);
    }

    const port = parseInt(process.env.PORT || '3000');
    const server = new NetWorthServer(port);

    await server.initialize(accessUrl);
    server.start();
}

// Run
main().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
});

export { SimpleFinClient, NetWorthServer };