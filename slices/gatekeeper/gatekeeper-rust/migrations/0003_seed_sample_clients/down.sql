-- Remove the seeded SMART sample-app clients.
DELETE FROM clients WHERE client_id IN (
    'growth_chart',
    'my_web_app',
    'cc344727-6f90-496c-94fd-c7829aa9a51d'
);
