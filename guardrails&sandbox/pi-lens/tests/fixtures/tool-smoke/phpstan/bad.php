<?php
// Tool-smoke fixture (#1937) — phpstan flags the undefined function call.
function greet(string $name): int
{
    return $name;
}

echo greet('world');
