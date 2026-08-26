primitive and_udp(output_value, input_a, input_b);
  output output_value;
  input input_a;
  input input_b;
  table
    0 ? : 0;
    ? 0 : 0;
    1 1 : 1;
    1 x : x;
    x 1 : x;
  endtable
endprimitive

module udp_bench;
  integer i;
  reg input_a;
  reg input_b;
  wire output_value;

  and_udp dut(output_value, input_a, input_b);

  initial begin
    input_a = 0;
    input_b = 0;
    for (i = 0; i < 20000; i = i + 1) begin
      input_a = i[0];
      input_b = i[1];
      #1;
      if (output_value !== (input_a & input_b)) begin
        $display("FAIL udp");
        $finish;
      end
    end
    $display("PASS udp");
    $finish;
  end
endmodule
