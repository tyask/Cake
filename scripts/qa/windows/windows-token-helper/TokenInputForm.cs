using System;
using System.Drawing;
using System.Security;
using System.Windows.Forms;

namespace CakeQaHelper
{
    /// <summary>
    /// A local, save-only handoff. The token is never sent to a network service
    /// or written to diagnostics by this form.
    /// </summary>
    public sealed class TokenInputForm : Form
    {
        private readonly TokenStore store;
        private readonly TextBox tokenBox;
        private readonly CheckBox scopeConfirmed;
        private readonly Button saveButton;
        private readonly Button closeButton;
        private readonly Label statusLabel;
        private bool blocked;
        private bool busy;
        private bool saved;

        public TokenInputForm(TokenStore store)
        {
            if (store == null)
            {
                throw new ArgumentNullException("store");
            }

            this.store = store;
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Segoe UI", 12F, FontStyle.Regular, GraphicsUnit.Point);
            Text = "Cake QA — トークンを安全に保存";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(940, 700);
            MinimumSize = new Size(880, 730);
            MaximizeBox = false;
            BackColor = Color.FromArgb(247, 249, 252);

            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Padding = new Padding(28, 22, 28, 22);
            layout.ColumnCount = 1;
            layout.RowCount = 9;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(layout);

            Label heading = MakeLabel("Cake 専用トークンの保存", Color.FromArgb(25, 42, 67));
            heading.Font = new Font(Font.FontFamily, 20F, FontStyle.Bold);
            heading.Margin = new Padding(0, 0, 0, 10);
            layout.Controls.Add(heading, 0, 0);

            Label introduction = MakeLabel(
                "Vercel で本人が作成したトークンを、下の伏字欄へ入力してください。\r\n" +
                "この画面は保存専用です。接続確認・A/B QA・DB 操作は実行しません。",
                Color.FromArgb(45, 58, 77));
            introduction.Margin = new Padding(0, 0, 0, 16);
            layout.Controls.Add(introduction, 0, 1);

            Panel storagePanel = new Panel();
            storagePanel.AutoSize = true;
            storagePanel.Dock = DockStyle.Top;
            storagePanel.Padding = new Padding(14, 11, 14, 11);
            storagePanel.Margin = new Padding(0, 0, 0, 15);
            storagePanel.BackColor = Color.White;
            storagePanel.BorderStyle = BorderStyle.FixedSingle;
            TableLayoutPanel storageLayout = new TableLayoutPanel();
            storageLayout.AutoSize = true;
            storageLayout.Dock = DockStyle.Top;
            storageLayout.ColumnCount = 1;
            storageLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            Label storageTitle = MakeLabel("保存先（リポジトリ外）", Color.FromArgb(25, 42, 67));
            storageTitle.Font = new Font(Font, FontStyle.Bold);
            storageTitle.Margin = new Padding(0, 0, 0, 5);
            storageLayout.Controls.Add(storageTitle);
            TextBox pathBox = new TextBox();
            pathBox.ReadOnly = true;
            pathBox.Multiline = true;
            pathBox.WordWrap = true;
            pathBox.ScrollBars = ScrollBars.Vertical;
            pathBox.Height = 60;
            pathBox.Dock = DockStyle.Top;
            pathBox.BorderStyle = BorderStyle.None;
            pathBox.BackColor = Color.White;
            pathBox.ForeColor = Color.FromArgb(45, 58, 77);
            pathBox.Text = store.TokenPath;
            pathBox.TabStop = false;
            storageLayout.Controls.Add(pathBox);
            storagePanel.Controls.Add(storageLayout);
            layout.Controls.Add(storagePanel, 0, 2);

            Label storageExplanation = MakeLabel(
                "• Windows DPAPI CurrentUser で暗号化し、本人用 ACL で保護します。\r\n" +
                "• 同じ Windows ユーザーで動くプログラムは復号できます。\r\n" +
                "• Cake 内の読書き権限があり、本番環境も対象になり得ます。\r\n" +
                "• 有効期限・失効までは再入力不要です。期限後は再設定が必要です。",
                Color.FromArgb(45, 58, 77));
            storageExplanation.Margin = new Padding(0, 0, 0, 17);
            layout.Controls.Add(storageExplanation, 0, 3);

            Label tokenLabel = MakeLabel("Vercel トークン（伏字・表示切替なし）", Color.FromArgb(25, 42, 67));
            tokenLabel.Margin = new Padding(0, 0, 0, 5);
            layout.Controls.Add(tokenLabel, 0, 4);

            tokenBox = new TextBox();
            tokenBox.UseSystemPasswordChar = true;
            tokenBox.MaxLength = 32768;
            tokenBox.Dock = DockStyle.Top;
            tokenBox.Margin = new Padding(0, 0, 0, 12);
            tokenBox.AccessibleName = "Vercel トークンの伏字入力";
            tokenBox.TextChanged += delegate { UpdateSaveButton(); };
            layout.Controls.Add(tokenBox, 0, 5);

            scopeConfirmed = new CheckBox();
            scopeConfirmed.AutoSize = true;
            scopeConfirmed.Dock = DockStyle.Top;
            scopeConfirmed.MaximumSize = new Size(850, 0);
            scopeConfirmed.Text = "本人が Scope = fumin1 / Cake と有効期限を確認しました。";
            scopeConfirmed.Margin = new Padding(0, 0, 0, 12);
            scopeConfirmed.CheckedChanged += delegate { UpdateSaveButton(); };
            layout.Controls.Add(scopeConfirmed, 0, 6);

            statusLabel = MakeLabel(
                "入力待ちです。本人が「保存する」を押して確定するまで、保存されません。",
                Color.FromArgb(45, 58, 77));
            statusLabel.Margin = new Padding(0, 0, 0, 12);
            statusLabel.AccessibleName = "保存状態";
            layout.Controls.Add(statusLabel, 0, 7);

            FlowLayoutPanel actions = new FlowLayoutPanel();
            actions.Dock = DockStyle.Top;
            actions.AutoSize = true;
            actions.FlowDirection = FlowDirection.RightToLeft;
            actions.WrapContents = false;
            actions.Margin = new Padding(0);

            closeButton = new Button();
            closeButton.Text = "保存せず閉じる";
            closeButton.AutoSize = true;
            closeButton.MinimumSize = new Size(165, 42);
            closeButton.Margin = new Padding(10, 0, 0, 0);
            closeButton.DialogResult = DialogResult.Cancel;
            closeButton.Click += delegate { Close(); };
            actions.Controls.Add(closeButton);

            saveButton = new Button();
            saveButton.Text = "保存する";
            saveButton.AutoSize = true;
            saveButton.MinimumSize = new Size(150, 42);
            saveButton.Margin = new Padding(0);
            saveButton.BackColor = Color.FromArgb(24, 79, 150);
            saveButton.ForeColor = Color.White;
            saveButton.FlatStyle = FlatStyle.Flat;
            saveButton.FlatAppearance.BorderSize = 0;
            saveButton.Enabled = false;
            saveButton.Click += SaveClicked;
            actions.Controls.Add(saveButton);
            layout.Controls.Add(actions, 0, 8);
            CancelButton = closeButton;

            // No AcceptButton: entering or pasting text does not trigger Save.
            FormClosing += delegate { tokenBox.Clear(); };
            CheckInitialState();
        }

        private static Label MakeLabel(string text, Color color)
        {
            Label label = new Label();
            label.Text = text;
            label.AutoSize = true;
            label.Dock = DockStyle.Top;
            label.MaximumSize = new Size(870, 0);
            label.ForeColor = color;
            label.UseMnemonic = false;
            return label;
        }

        private void CheckInitialState()
        {
            try
            {
                if (store.Exists)
                {
                    BlockInput("既存のトークンがあるため入力・保存を停止しました。上書きはしません。");
                    return;
                }

                store.ValidateNewStore();
            }
            catch (SafeFailure)
            {
                BlockInput("保存先の安全性を確認できないため入力・保存を停止しました。設定は変更していません。");
            }
            catch (Exception)
            {
                BlockInput("保存先を確認できないため入力・保存を停止しました。設定は変更していません。");
            }
        }

        private void BlockInput(string message)
        {
            blocked = true;
            tokenBox.Clear();
            tokenBox.Enabled = false;
            scopeConfirmed.Enabled = false;
            saveButton.Enabled = false;
            statusLabel.ForeColor = Color.FromArgb(139, 57, 33);
            statusLabel.Text = message;
        }

        private void UpdateSaveButton()
        {
            // TextChanged may fire while controls are being initialized.
            if (saveButton != null && scopeConfirmed != null)
            {
                saveButton.Enabled = !blocked && !busy && !saved &&
                    scopeConfirmed.Checked && tokenBox.TextLength > 0;
            }
        }

        private static bool LooksLikeToken(string value)
        {
            if (value == null || value.Length < 24 || value.Length > 32768 ||
                !value.StartsWith("vcp_", StringComparison.Ordinal))
            {
                return false;
            }

            for (int i = 0; i < value.Length; i++)
            {
                if (Char.IsWhiteSpace(value[i]) || Char.IsControl(value[i]))
                {
                    return false;
                }
            }

            return true;
        }

        private void SaveClicked(object sender, EventArgs e)
        {
            if (blocked || busy || saved || !scopeConfirmed.Checked)
            {
                return;
            }

            string input = tokenBox.Text;
            if (!LooksLikeToken(input))
            {
                input = null;
                tokenBox.Clear();
                statusLabel.ForeColor = Color.FromArgb(139, 57, 33);
                statusLabel.Text = "形式を確認してください。vcp_ で始まるトークンを、空白や改行なしで入力してください。";
                tokenBox.Focus();
                return;
            }

            DialogResult confirmation = MessageBox.Show(this,
                "fumin1 / Cake のトークンと有効期限を本人が確認しましたか？\r\n\r\n" +
                "表示中の保存先へ Windows ユーザーに紐づけて暗号化保存します。\r\n" +
                "同じ Windows ユーザーのプログラムは復号できます。\r\n" +
                "接続確認・QA・DB 操作は行いません。\r\n\r\n保存を確定しますか？",
                "本人による保存の確定", MessageBoxButtons.YesNo,
                MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (confirmation != DialogResult.Yes)
            {
                input = null;
                return;
            }

            busy = true;
            UpdateSaveButton();
            closeButton.Enabled = false;
            try
            {
                // The store rechecks existence and ACLs; it must never overwrite.
                store.ValidateNewStore();
                using (SecureString secureToken = new SecureString())
                {
                    for (int i = 0; i < input.Length; i++)
                    {
                        secureToken.AppendChar(input[i]);
                    }
                    secureToken.MakeReadOnly();
                    store.Save(secureToken);
                }

                saved = true;
                tokenBox.Enabled = false;
                scopeConfirmed.Enabled = false;
                closeButton.Text = "閉じる";
                statusLabel.ForeColor = Color.FromArgb(30, 104, 62);
                statusLabel.Text = "暗号化保存が完了しました。トークンの接続・権限・QA は未確認です。";
            }
            catch (SafeFailure)
            {
                BlockInput("安全に保存できなかったため停止しました。既存トークンは上書きしていません。内容を確認してから再開してください。");
            }
            catch (Exception)
            {
                BlockInput("保存処理で問題が発生したため停止しました。保存状態を確認してから再開してください。");
            }
            finally
            {
                // WinForms uses managed strings; keep their lifetime short and
                // never copy the value to a message, command, clipboard, or log.
                input = null;
                tokenBox.Clear();
                busy = false;
                closeButton.Enabled = true;
                UpdateSaveButton();
            }
        }
    }
}
