require "json"
require_relative "helpers/utils"

module Animals
  class Animal
    attr_reader :name, :age

    def initialize(name, age)
      @name = name
      @age = age
    end

    def speak
      raise NotImplementedError
    end

    def to_s
      "#{name} (#{age})"
    end
  end

  class Dog < Animal
    def speak
      "Woof!"
    end

    def fetch(item)
      "#{name} fetches #{item}"
    end
  end

  class Cat < Animal
    def speak
      "Meow!"
    end

    def self.create(name)
      new(name, 0)
    end
  end
end

module Serializable
  def to_json
    JSON.generate(to_h)
  end
end

def greet(name)
  puts "Hello, #{name}!"
end

ANIMALS_VERSION = "1.0.0"
