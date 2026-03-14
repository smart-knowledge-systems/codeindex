defmodule Animals.Dog do
  @moduledoc """
  A Dog module for demonstration.
  """

  use GenServer
  import Enum, only: [map: 2]
  alias Animals.{Cat, Bird}
  require Logger

  defstruct [:name, :age, :breed]

  @doc "Creates a new dog"
  def new(name, age) do
    %__MODULE__{name: name, age: age}
  end

  defp validate(dog) do
    dog.name != nil
  end

  def speak(dog) when is_map(dog) do
    "Woof! I'm #{dog.name}"
  end

  def speak(_other) do
    "Woof!"
  end

  defmacro define_greeting(name) do
    quote do
      def greet do
        "Hello from #{unquote(name)}"
      end
    end
  end
end

defprotocol Describable do
  @doc "Returns a description"
  def describe(data)
end

defimpl Describable, for: Animals.Dog do
  def describe(dog) do
    "Dog: #{dog.name}, age #{dog.age}"
  end
end

defmodule Animals.Cat do
  @moduledoc false

  defstruct [:name, :color]

  def new(name, color \\ "black") do
    %__MODULE__{name: name, color: color}
  end

  defp purr do
    "Purr..."
  end

  defmacrop internal_macro do
    quote do: :ok
  end
end

defmodule MathUtils do
  @doc "Adds two numbers"
  def add(a, b), do: a + b

  def subtract(a, b), do: a - b

  def divide(_a, 0), do: {:error, :division_by_zero}
  def divide(a, b), do: {:ok, a / b}
end
