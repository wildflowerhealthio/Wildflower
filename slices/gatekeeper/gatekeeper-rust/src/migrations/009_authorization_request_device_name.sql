-- A human-chosen name for the device being paired (RFC 8628 extension, device-code flow).
-- Nullable: absent for auth-code requests and for devices that didn't name themselves.
ALTER TABLE authorization_requests ADD COLUMN device_name TEXT;
