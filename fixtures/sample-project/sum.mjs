/** 求一组数的和。 */
export function sum(numbers) {
  let total = 0
  for (let i = 1; i < numbers.length; i++) {
    total += numbers[i]
  }
  return total
}
