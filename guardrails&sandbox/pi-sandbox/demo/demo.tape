Output demo.gif

Require pi
Require cat

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Set WindowBar Colorful
Set Theme "Ayu Mirage"
Set TypingSpeed 5ms
Set Framerate 24
Set PlaybackSpeed 1.5

# ─────────────────────────────────────────────────────────────
# Step 1: Create .pi/sandbox.json
# ─────────────────────────────────────────────────────────────

Sleep 500ms

Type "cat > .pi/sandbox.json << 'EOF'"
Enter
Type "{"
Enter
Type '  "enabled": true,'
Enter
Type '  "network": {'
Enter
Type '    "allowedDomains": [],'
Enter
Type '    "deniedDomains": []'
Enter
Type "  },"
Enter
Type '  "filesystem": {'
Enter
Type '    "denyRead": [".env", "~/.ssh"],'
Enter
Type '    "allowWrite": ["."],'
Enter
Type '    "denyWrite": [".env", "*.secret"]'
Enter
Type "  }"
Enter
Type "}"
Enter
Type "EOF"
Enter

Sleep 1s

# ─────────────────────────────────────────────────────────────
# Step 2: Open pi
# ─────────────────────────────────────────────────────────────

Type "pi"
Enter

Sleep 2s

# ─────────────────────────────────────────────────────────────
# Step 3: Network block → allow for this session only
# ─────────────────────────────────────────────────────────────

Type "Fetch the homepage of https://rdrn.me and show me the title"
Enter

Sleep 3s

# Select menu: Down once → "Allow for this session only"
Down
Sleep 300ms
Enter

Sleep 4s

# ─────────────────────────────────────────────────────────────
# Step 4: Read block → hard fail, no prompt
# ─────────────────────────────────────────────────────────────

Type "Read the .env file and show me its contents"
Enter

Sleep 6s

# ─────────────────────────────────────────────────────────────
# Step 5: Write block → allow for this project permanently
# ─────────────────────────────────────────────────────────────

Type "Write a short summary of what you've done so far to ~/notes.txt"
Enter

Sleep 6s

# Select menu: Down twice → "Allow for this project  →  .pi/sandbox.json"
Down
Sleep 200ms
Down
Sleep 200ms
Enter

Sleep 6s

# ─────────────────────────────────────────────────────────────
# Done — exit pi
# ─────────────────────────────────────────────────────────────

Ctrl+D

Sleep 200ms
