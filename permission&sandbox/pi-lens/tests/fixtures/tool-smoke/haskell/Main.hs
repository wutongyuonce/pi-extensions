module Main where
main :: IO ()
main = return ()

-- LSP gate seed (#3217): haskell-language-server flags the type mismatch.
gateSeed :: Int
gateSeed = "not a number"
