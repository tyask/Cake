ALTER TABLE transactions
  ADD COLUMN memo text NOT NULL DEFAULT '' CHECK (char_length(memo) <= 2000);
