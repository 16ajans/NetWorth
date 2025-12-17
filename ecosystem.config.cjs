module.exports = {
    apps: [{
        name: 'networth',
        script: './dist/app.js',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '200M',
        env: {
            NODE_ENV: 'production',
            PORT: 3000
        },
        error_file: './logs/err.log',
        out_file: './logs/out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
        merge_logs: true,
        // Restart the app at 3 AM daily to ensure fresh data
        cron_restart: '0 3 * * *'
    }]
};