-- Reverse of up.sql.
UPDATE clients
   SET allowed_scopes = '["openid","wildflower/Grant.rd","wildflower/Client.ru","wildflower/Token.d"]'
 WHERE client_id = '7277e898bee8ac81ea44788236e619a5'
   AND allowed_scopes = '["openid","wildflower/Grant.rd","wildflower/Client.ru","wildflower/Token.d","wildflower/BrowserSession.rd"]';
