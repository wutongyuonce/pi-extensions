def parse_and_eval(input)
  begin
    Integer(input)
  rescue
    # BUG:silent-error empty rescue
  end

  secret = "hardcoded-ruby-secret" # BUG:secrets
  secret

  # BUG:injection eval on user input
  eval(input)
end
