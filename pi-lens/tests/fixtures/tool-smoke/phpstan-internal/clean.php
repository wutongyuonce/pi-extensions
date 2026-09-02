<?php
// Tool-smoke fixture (#1937) — the file is clean, so the only finding phpstan
// reports is the unmatched ignore pattern, which arrives in the TOP-LEVEL
// errors[] array rather than under files{}.
function add(int $a, int $b): int
{
    return $a + $b;
}

echo add(1, 2);
